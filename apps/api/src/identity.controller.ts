import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Req } from '@nestjs/common';
import { createAccessTokenVerifier, InvalidAccessTokenError } from '@pss/auth-client';
import { CurrentUserResponseSchema, CurrentUserPermissionsResponseSchema, DomainError, registryCatalog, type CurrentUserResponse, type CurrentUserPermissionsResponse } from '@pss/contracts';
import { assertSessionActive, checkAccess, loadActiveRoleAssignments, requireRecentMfa, resolveActiveUser, resolveRolePermissions, revokeUserSessions } from '@pss/identity';
import { IdempotencyError, withIdempotentCommand, type ApprovalAuthorization } from '@pss/platform';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

const RevokeSessionsSchema = z.strictObject({ reason: z.string().trim().min(1).max(200) });

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

  @Get('permissions')
  getCurrentUserPermissions(@Req() request: { headers: { authorization?: string } }): Promise<CurrentUserPermissionsResponse> {
    return this.identity.getCurrentUserPermissions(request.headers.authorization);
  }
}

@Controller('identity')
export class IdentityAdminController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

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
