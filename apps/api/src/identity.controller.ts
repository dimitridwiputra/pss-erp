import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Query, Req } from '@nestjs/common';
import { createAccessTokenVerifier, InvalidAccessTokenError } from '@pss/auth-client';
import { CurrentUserResponseSchema, CurrentUserPermissionsResponseSchema, DomainError, registryCatalog, type CurrentUserResponse, type CurrentUserPermissionsResponse } from '@pss/contracts';
import {
  assertSessionActive, checkAccess, loadActiveRoleAssignments, requireAccess, requireRecentMfa,
  resolveActiveUser, resolveNavigation, resolveRolePermissions, revokeUserSessions,
} from '@pss/identity';
import { IdempotencyError, withIdempotentCommand, type ApprovalAuthorization } from '@pss/platform';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

const RevokeSessionsSchema = z.strictObject({ reason: z.string().trim().min(1).max(200) });

/**
 * RBAC-003 / IDN-003 response shapes.
 *
 * Declared here rather than in `@pss/contracts` because that package is being edited
 * concurrently; they are plain wire contracts with no cross-domain meaning, so
 * moving them is mechanical. Labels are Indonesian and no field carries a raw enum
 * a client would have to translate.
 */
const NavigationItemSchema = z.strictObject({ key: z.string().min(1), label: z.string().min(1) });
const NavigationAppSchema = z.strictObject({
  app: z.string().min(1),
  accessPermission: z.string().min(1),
  label: z.string().min(1),
  items: z.array(NavigationItemSchema),
});
const NavigationResponseSchema = z.strictObject({
  apps: z.array(NavigationAppSchema),
  bottomNav: z.array(NavigationItemSchema.extend({ href: z.string().min(1) })),
  bottomNavTrimmed: z.boolean(),
});
const AccessReviewHolderSchema = z.strictObject({
  userId: z.uuid(),
  displayName: z.string().min(1),
  accountStatus: z.enum(['AKTIF', 'NONAKTIF', 'TERKUNCI']),
  roleCode: z.string().min(1),
  scopeType: z.string().min(1),
  scopeId: z.uuid().nullable(),
  validFrom: z.string().min(1),
  validTo: z.string().min(1).nullable(),
  permissions: z.array(z.string()),
  unresolvedPermissionGroups: z.array(z.string()),
});
const AccessReviewResponseSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().nullable(),
  holders: z.array(AccessReviewHolderSchema),
});
type NavigationResponse = z.infer<typeof NavigationResponseSchema>;
type AccessReviewResponse = z.infer<typeof AccessReviewResponseSchema>;

@Injectable()
export class IdentityService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;
  private readonly verify = process.env.PSS_OIDC_ISSUER && process.env.PSS_OIDC_AUDIENCE && process.env.PSS_OIDC_JWKS_URI
    ? createAccessTokenVerifier({
      issuer: process.env.PSS_OIDC_ISSUER,
      audience: process.env.PSS_OIDC_AUDIENCE,
      jwksUri: process.env.PSS_OIDC_JWKS_URI,
    })
    : undefined;

  async getCurrentUser(authorizationHeader: string | undefined): Promise<CurrentUserResponse> {
    if (!authorizationHeader) throw new DomainError('UNAUTHENTICATED');
    if (!this.verify || !this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    try {
      const token = await this.verify(authorizationHeader);
      const user = await resolveActiveUser(this.pool, token.subject);
      await assertSessionActive(this.pool, user.id, token.authenticationAt);
      return CurrentUserResponseSchema.parse(user);
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw new DomainError('UNAUTHENTICATED');
      if (error instanceof DomainError) throw error;
      throw new DomainError('DEPENDENCY_UNAVAILABLE');
    }
  }

  /**
   * PLT-006: revoking sessions is a state mutation, so a retry must replay the stored
   * response rather than bump `identity.user_account.version` and append a second
   * `USER_SESSIONS_REVOKED` audit entry. The revocation is handed the transaction that
   * `withIdempotentCommand` already opened, so the idempotency row and the audited
   * mutation commit or roll back together.
   */
  async revokeSessions(authorizationHeader: string | undefined, targetUserId: string, reason: string, requestId: string, idempotencyKey: string): Promise<{ status: 'REVOKED' }> {
    if (!authorizationHeader) throw new DomainError('UNAUTHENTICATED');
    const { verify, pool } = this;
    if (!verify || !pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    let token;
    try {
      token = await verify(authorizationHeader);
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw new DomainError('UNAUTHENTICATED');
      throw error;
    }
    const actor = await resolveActiveUser(pool, token.subject);
    await assertSessionActive(pool, actor.id, token.authenticationAt);
    requireRecentMfa(token);
    try {
      const result = await withIdempotentCommand<PoolClient>(
        pool,
        {
          organizationId: actor.organizationId,
          identityId: actor.id,
          commandName: 'identity.revokeSessions',
          key: idempotencyKey,
          requestHash: hashRequestBody({ targetUserId, reason }),
        },
        async (client, work) => work(client),
        async (client) => {
          await revokeUserSessions(pool, {
            actorId: actor.id, organizationId: actor.organizationId, targetUserId, reason, requestId, client,
          });
          return { code: 200, body: { status: 'REVOKED' } };
        },
      );
      return result.body as { status: 'REVOKED' };
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  async canApprove(authorizationHeader: string | undefined, request: ApprovalAuthorization, enforceMfa: boolean): Promise<boolean> {
    if (!authorizationHeader) throw new DomainError('UNAUTHENTICATED');
    if (!this.verify || !this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    let token;
    try { token = await this.verify(authorizationHeader); }
    catch (error) {
      if (error instanceof InvalidAccessTokenError) throw new DomainError('UNAUTHENTICATED');
      throw error;
    }
    const actor = await resolveActiveUser(this.pool, token.subject);
    await assertSessionActive(this.pool, actor.id, token.authenticationAt);
    if (actor.id !== request.actorId || actor.organizationId !== request.organizationId) return false;
    const rightsHolderId = request.onBehalfOf ?? actor.id;
    if (request.onBehalfOf) {
      const holder = await this.pool.query<{ organization_id: string; status: string }>(
        'SELECT organization_id, status FROM identity.user_account WHERE id = $1', [rightsHolderId],
      );
      if (holder.rows[0]?.organization_id !== actor.organizationId || holder.rows[0]?.status !== 'ACTIVE') return false;
    }
    const assignments = await loadActiveRoleAssignments(this.pool, rightsHolderId);
    if (!assignments.some((assignment) => assignment.roleCode === request.roleCode)) return false;
    const allowed = checkAccess({
      actorId: rightsHolderId, organizationId: request.organizationId,
      assignments: assignments.filter((assignment) => assignment.roleCode === request.roleCode),
      permission: request.permission,
      resource: { organizationId: request.organizationId, ...(request.branchId ? { branchId: request.branchId } : {}) },
    });
    if (!allowed) return false;
    if (enforceMfa && registryCatalog.roles.find((role) => role.code === request.roleCode)?.mfaRequired) {
      requireRecentMfa(token);
    }
    return true;
  }

  async getCurrentUserPermissions(authorizationHeader: string | undefined): Promise<CurrentUserPermissionsResponse> {
    const user = await this.getCurrentUser(authorizationHeader);
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    const assignments = await loadActiveRoleAssignments(this.pool, user.id);
    const grants = assignments.flatMap((assignment) =>
      resolveRolePermissions(assignment.roleCode).permissions.map((permission) => ({
        permission,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
      })));
    return CurrentUserPermissionsResponseSchema.parse({ userId: user.id, grants });
  }

  /**
   * RBAC-003.R01: navigation is computed here, on the server, from the caller's
   * effective grants. The response contains only apps and menu items the caller may
   * actually open, so a client cannot reveal a hidden entry by constructing one.
   * RBAC-003.BR01 therefore holds by construction: a denied permission produces an
   * absent item rather than a disabled one.
   */
  async getCurrentUserNavigation(authorizationHeader: string | undefined): Promise<NavigationResponse> {
    const user = await this.getCurrentUser(authorizationHeader);
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    const assignments = await loadActiveRoleAssignments(this.pool, user.id);
    const permissions = [...new Set(assignments.flatMap((assignment) => resolveRolePermissions(assignment.roleCode).permissions))];
    const navigation = resolveNavigation(permissions);
    return NavigationResponseSchema.parse({
      apps: navigation.apps,
      bottomNav: navigation.bottomNav,
      bottomNavTrimmed: navigation.bottomNavTrimmed,
    });
  }

  /**
   * IDN-003.R02: the access review report. Scope is filtered server-side, so a
   * reviewer only ever sees the branches they are entitled to inspect.
   */
  async accessReview(authorizationHeader: string | undefined, branchId: string | undefined): Promise<AccessReviewResponse> {
    const user = await this.getCurrentUser(authorizationHeader);
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    requireAccess({
      actorId: user.id,
      organizationId: user.organizationId,
      assignments: await loadActiveRoleAssignments(this.pool, user.id),
      permission: 'audit.entry.read',
      resource: branchId ? { organizationId: user.organizationId, branchId } : { organizationId: user.organizationId },
    });

    // The report is a read over identity.role_assignment only. Each row is resolved
    // through the Appendix D registry so the response carries granted permissions and
    // any unresolved permission group, rather than a raw role code the caller would
    // have to interpret.
    //
    // `identity.role_assignment` is scoped generically (scope_type + scope_id), not
    // per-branch, so a branch filter selects assignments scoped to that branch and
    // organization-wide ones, which also apply to it.
    const scopeClause = branchId
      ? `AND (r.scope_id = $2::uuid
             OR (r.scope_type = 'ORGANIZATION' AND r.scope_id = $3::uuid))`
      : '';
    const parameters = branchId
      ? [user.organizationId, branchId, user.organizationId]
      : [user.organizationId];

    const result = await this.pool.query<{
      user_id: string; display_name: string; role_code: string;
      scope_type: string; scope_id: string | null;
      effective_at: Date; expires_at: Date | null; status: string;
    }>(
      `SELECT r.user_id, u.display_name, r.role_code, r.scope_type, r.scope_id,
              r.effective_at, r.expires_at, u.status
         FROM identity.role_assignment r
         JOIN identity.user_account u ON u.id = r.user_id
        WHERE u.organization_id = $1::uuid
          AND r.revoked_at IS NULL
          AND r.effective_at <= now()
          AND (r.expires_at IS NULL OR r.expires_at > now())
          ${scopeClause}
        ORDER BY u.display_name, r.role_code`,
      parameters,
    );

    const holders = result.rows.map((row) => {
      const resolved = resolveRolePermissions(row.role_code);
      return {
        userId: row.user_id,
        displayName: row.display_name,
        accountStatus: row.status === 'ACTIVE' ? 'AKTIF' : row.status === 'INACTIVE' ? 'NONAKTIF' : 'TERKUNCI',
        roleCode: row.role_code,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        validFrom: row.effective_at.toISOString().slice(0, 10),
        validTo: row.expires_at ? row.expires_at.toISOString().slice(0, 10) : null,
        permissions: resolved.permissions,
        // An unresolved group is surfaced rather than hidden: it is a data gap the
        // reviewer needs to see, not a permission that silently resolves to nothing.
        unresolvedPermissionGroups: resolved.unresolvedGroups,
      };
    });
    return AccessReviewResponseSchema.parse({ organizationId: user.organizationId, branchId: branchId ?? null, holders });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Controller('me')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get()
  getCurrentUser(@Req() request: { headers: { authorization?: string } }): Promise<CurrentUserResponse> {
    return this.identity.getCurrentUser(request.headers.authorization);
  }

  /**
   * RBAC-003: server-computed navigation. A read, so no idempotency key is required;
   * the command-fitness gate only constrains mutating routes.
   */
  @Get('navigation')
  getCurrentUserNavigation(@Req() request: { headers: { authorization?: string } }): Promise<NavigationResponse> {
    return this.identity.getCurrentUserNavigation(request.headers.authorization);
  }

  @Get('permissions')
  getCurrentUserPermissions(@Req() request: { headers: { authorization?: string } }): Promise<CurrentUserPermissionsResponse> {
    return this.identity.getCurrentUserPermissions(request.headers.authorization);
  }
}

@Controller('identity')
export class IdentityAdminController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  /**
   * IDN-003.R02 access review, scoped server-side. Reading a review report is not a
   * business mutation, so it is gated on the technical `audit.entry.read` permission
   * rather than an identity-management permission.
   */
  @Get('access-review')
  accessReview(
    @Req() request: { headers: { authorization?: string } },
    @Query('branchId', new ZodValidationPipe(z.uuid().optional())) branchId?: string,
  ): Promise<AccessReviewResponse> {
    return this.identity.accessReview(request.headers.authorization, branchId);
  }

  @Post('users/:id/revoke-sessions')
  revokeSessions(
    @Req() request: { headers: { authorization?: string; 'x-request-id'?: string; 'idempotency-key'?: string } },
    @Param('id') targetUserId: string,
    @Body(new ZodValidationPipe(RevokeSessionsSchema)) body: { reason: string },
  ): Promise<{ status: 'REVOKED' }> {
    if (!z.uuid().safeParse(targetUserId).success) throw new DomainError('VALIDATION_FAILED');
    const idempotencyKey = readIdempotencyKey(request as never);
    return this.identity.revokeSessions(request.headers.authorization, targetUserId, body.reason,
      request.headers['x-request-id'] ?? randomUUID(), idempotencyKey);
  }
}
