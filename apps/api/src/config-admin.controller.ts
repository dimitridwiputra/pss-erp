import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Query, Req } from '@nestjs/common';
import { DomainError, registryCatalog, type CurrentUserResponse } from '@pss/contracts';
import { checkAccess, loadActiveRoleAssignments } from '@pss/identity';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import {
  configGateReport, IdempotencyError, listConfigValues, listFeatureFlags, listFlagTargeting,
  loadConfigRows, loadFlagRows, proposeConfigValue, runCommand, setFeatureFlag, setFlagTargeting,
  staleFeatureFlags,
} from '@pss/platform';
import type { AuditedTransaction } from '@pss/platform';
import { Pool } from 'pg';
import { z } from 'zod';
import { IdentityService } from './identity.controller';

type AuthedRequest = { headers: { authorization?: string; 'x-request-id'?: string; 'idempotency-key'?: string } };

/**
 * PLT-009 / PLT-010 write permission. The value is read from the generated registry instead of
 * being written as a literal, so a registry change moves the gate with it (AGENTS.md §18).
 *
 * The registry grants SYS-ADMIN a `configuration.*.manage` wildcard, while `@pss/identity`'s
 * `checkAccess` matches permission codes exactly and resolves them from a hand-transcribed
 * group table that does not contain that wildcard. This gate is therefore fail-closed: it denies
 * every caller until the wildcard is transcribed. That is the correct outcome under AGENTS.md
 * §15 — a system admin holds technical permissions, not implicit mutation permission, and a
 * configuration change is the clearest case of a change that must never happen by accident.
 * Transcribing the wildcard is an `@pss/identity` change, reported rather than made here.
 */
const CONFIG_MANAGE_PERMISSION = (() => {
  const group = registryCatalog.permissionGroups.find((entry) => entry.group === 'SYS-ADMIN');
  const permission = group?.permissions.find((code) => code.startsWith('configuration.'));
  if (!permission) {
    throw new Error('The SYS-ADMIN registry group no longer grants a configuration permission.');
  }
  return permission;
})();

const ScopeSchema = z.strictObject({
  branchId: z.uuid().optional(),
  principalId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});

const ProposeConfigBodySchema = z.strictObject({
  key: z.string().trim().min(1).max(200),
  scope: ScopeSchema.default({}),
  /** `null` is the documented KOSONG case: stored as such, never defaulted (PLT-009.NC02). */
  value: z.unknown().nullable(),
  /** The business date the value takes effect, in Asia/Jakarta. Never the server date (NC03). */
  validFrom: z.iso.date(),
  validTo: z.iso.date().optional(),
  reason: z.string().trim().min(1).max(500),
  requiresOwnerApproval: z.boolean().default(false),
  approvalId: z.uuid().optional(),
});
type ProposeConfigBody = z.infer<typeof ProposeConfigBodySchema>;

const SetFlagBodySchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  owner: z.string().trim().min(1).max(120),
  targetRemoveDate: z.iso.date().optional(),
});
type SetFlagBody = z.infer<typeof SetFlagBodySchema>;

const SetFlagTargetingBodySchema = z.strictObject({
  flagKey: z.string().trim().min(1).max(120),
  branchId: z.uuid().optional(),
  roleCode: z.string().trim().min(1).max(60).optional(),
  userId: z.uuid().optional(),
  enabled: z.boolean(),
  percentage: z.int().min(0).max(100).optional(),
  priority: z.int().min(0).max(1000).default(0),
  expiresAt: z.iso.datetime().optional(),
});
type SetFlagTargetingBody = z.infer<typeof SetFlagTargetingBodySchema>;

const KeyQuerySchema = z.string().trim().min(1).max(200);

/**
 * PLT-009 / PLT-010 administrative console surface (Konsol Sistem, ADM-008).
 *
 * PLT-006: every mutating route reads a client `Idempotency-Key` and replays its stored
 * response, so retrying "propose this value" or "turn the flag on" cannot create a second
 * revision or a second audit entry. RBAC-002 / AGENTS.md §15: the caller is always resolved
 * from the session, never from the body, and a write needs the registry's configuration
 * permission — a system admin is not implicitly allowed to change business configuration.
 */
@Injectable()
export class ConfigAdminService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  private requireUser(authorizationHeader: string | undefined): Promise<CurrentUserResponse> {
    return this.identity.getCurrentUser(authorizationHeader);
  }

  private async requireConfigurationWrite(authorizationHeader: string | undefined): Promise<CurrentUserResponse> {
    const user = await this.requireUser(authorizationHeader);
    const assignments = await loadActiveRoleAssignments(this.requirePool(), user.id);
    const allowed = checkAccess({
      actorId: user.id, organizationId: user.organizationId, assignments,
      permission: CONFIG_MANAGE_PERMISSION, resource: { organizationId: user.organizationId },
    });
    if (!allowed) throw new DomainError('PERMISSION_DENIED');
    return user;
  }

  /**
   * The replay record, the command, and the audit entries share one commit, so a retried write
   * returns the first response and a failed write leaves no partial configuration behind.
   */
  private async withIdempotency<T>(
    user: CurrentUserResponse, commandName: string, idempotencyKey: string,
    requestBody: unknown, execute: (transaction: AuditedTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await runCommand(
        this.requirePool(),
        {
          organizationId: user.organizationId, identityId: user.id, commandName,
          key: idempotencyKey, requestHash: hashRequestBody(requestBody),
        },
        async (transaction) => ({ code: 200, body: await execute(transaction) }),
      );
      return result.body as T;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  async proposeConfig(
    authorizationHeader: string | undefined, body: ProposeConfigBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireConfigurationWrite(authorizationHeader);
    return this.withIdempotency(user, 'platform.proposeConfigValue', idempotencyKey, body, ({ client }) =>
      proposeConfigValue(this.requirePool(), { ...body, organizationId: user.organizationId, requestId }, user.id, client));
  }

  async setFlag(
    authorizationHeader: string | undefined, body: SetFlagBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireConfigurationWrite(authorizationHeader);
    return this.withIdempotency(user, 'platform.setFeatureFlag', idempotencyKey, body, (transaction) =>
      setFeatureFlag(this.requirePool(), { ...body, organizationId: user.organizationId, requestId }, user.id, transaction));
  }

  async setFlagTargeting(
    authorizationHeader: string | undefined, body: SetFlagTargetingBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireConfigurationWrite(authorizationHeader);
    return this.withIdempotency(user, 'platform.setFlagTargeting', idempotencyKey, body, (transaction) =>
      setFlagTargeting(this.requirePool(), { ...body, organizationId: user.organizationId, requestId }, user.id, transaction));
  }

  async configValues(authorizationHeader: string | undefined, key: string, branchId?: string) {
    const user = await this.requireUser(authorizationHeader);
    return {
      values: await listConfigValues(this.requirePool(), key, user.organizationId, {
        ...(branchId ? { branchId } : {}),
      }),
    };
  }

  async configRows(authorizationHeader: string | undefined, key: string, branchId?: string) {
    const user = await this.requireUser(authorizationHeader);
    return {
      rows: await loadConfigRows(this.requirePool(), {
        key, organizationId: user.organizationId, scope: { ...(branchId ? { branchId } : {}) },
      }),
    };
  }

  async gateReport(authorizationHeader: string | undefined, businessDate: string) {
    await this.requireUser(authorizationHeader);
    return { entries: await configGateReport(this.requirePool(), businessDate) };
  }

  async flags(authorizationHeader: string | undefined) {
    await this.requireUser(authorizationHeader);
    return { flags: await listFeatureFlags(this.requirePool()) };
  }

  async flagTargeting(authorizationHeader: string | undefined, flagKey: string) {
    const user = await this.requireUser(authorizationHeader);
    return { rules: await listFlagTargeting(this.requirePool(), flagKey, user.organizationId) };
  }

  /**
   * The rows a caller hands to `evaluateFlag` or the OpenFeature provider, projected for the
   * caller's own context. An operator may pass `userId` to inspect the rollout as it lands on
   * one specific user; the organization and branch still come from the session, never the query,
   * so this cannot be pointed at another tenant.
   */
  async flagRows(authorizationHeader: string | undefined, flagKey: string, userId?: string) {
    const user = await this.requireUser(authorizationHeader);
    const assignments = await loadActiveRoleAssignments(this.requirePool(), user.id);
    return {
      rows: await loadFlagRows(this.requirePool(), {
        key: flagKey,
        context: {
          organizationId: user.organizationId,
          ...(user.primaryBranchId ? { branchId: user.primaryBranchId } : {}),
          // Every active role, so a rule targeting any one of them applies to this subject.
          roleCodes: assignments.map((assignment) => assignment.roleCode),
          userId: userId ?? user.id,
        },
      }),
    };
  }

  async staleFlags(authorizationHeader: string | undefined, businessDate: string) {
    await this.requireUser(authorizationHeader);
    return { flags: await staleFeatureFlags(this.requirePool(), businessDate) };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Controller('platform/config')
export class ConfigAdminController {
  constructor(@Inject(ConfigAdminService) private readonly config: ConfigAdminService) {}

  private idempotencyKey(request: AuthedRequest): string {
    return readIdempotencyKey(request as never);
  }

  private requestId(request: AuthedRequest): string {
    return request.headers['x-request-id'] ?? randomUUID();
  }

  @Post('values')
  proposeConfig(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(ProposeConfigBodySchema)) body: ProposeConfigBody,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.config.proposeConfig(request.headers.authorization, body, idempotencyKey, this.requestId(request));
  }

  @Get('values')
  configValues(
    @Req() request: AuthedRequest,
    @Query('key', new ZodValidationPipe(KeyQuerySchema)) key: string,
    @Query('branchId', new ZodValidationPipe(z.uuid().optional())) branchId?: string,
  ) {
    return this.config.configValues(request.headers.authorization, key, branchId);
  }

  /**
   * The effective-dated rows a reader hands to `@pss/configuration`'s `getConfig`. The library
   * owns resolution, so this returns the facts rather than a resolved value that a second
   * implementation would have to keep in step.
   */
  @Get('values/rows')
  configRows(
    @Req() request: AuthedRequest,
    @Query('key', new ZodValidationPipe(KeyQuerySchema)) key: string,
    @Query('branchId', new ZodValidationPipe(z.uuid().optional())) branchId?: string,
  ) {
    return this.config.configRows(request.headers.authorization, key, branchId);
  }

  @Get('gate-report')
  gateReport(
    @Req() request: AuthedRequest,
    @Query('businessDate', new ZodValidationPipe(z.iso.date())) businessDate: string,
  ) {
    return this.config.gateReport(request.headers.authorization, businessDate);
  }
}

@Controller('platform/flags')
export class FeatureFlagController {
  constructor(@Inject(ConfigAdminService) private readonly config: ConfigAdminService) {}

  private idempotencyKey(request: AuthedRequest): string {
    return readIdempotencyKey(request as never);
  }

  private requestId(request: AuthedRequest): string {
    return request.headers['x-request-id'] ?? randomUUID();
  }

  @Get()
  flags(@Req() request: AuthedRequest) {
    return this.config.flags(request.headers.authorization);
  }

  /** PLT-010.AC04: flags past their target removal date, so the registry stays clean. */
  @Get('stale')
  staleFlags(
    @Req() request: AuthedRequest,
    @Query('businessDate', new ZodValidationPipe(z.iso.date())) businessDate: string,
  ) {
    return this.config.staleFlags(request.headers.authorization, businessDate);
  }

  @Post()
  setFlag(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(SetFlagBodySchema)) body: SetFlagBody,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.config.setFlag(request.headers.authorization, body, idempotencyKey, this.requestId(request));
  }

  @Get(':key/targeting')
  flagTargeting(
    @Req() request: AuthedRequest,
    @Param('key', new ZodValidationPipe(z.string().trim().min(1).max(120))) flagKey: string,
  ) {
    return this.config.flagTargeting(request.headers.authorization, flagKey);
  }

  /** The rows a caller hands to `evaluateFlag` or the OpenFeature provider. */
  @Get(':key/rows')
  flagRows(
    @Req() request: AuthedRequest,
    @Param('key', new ZodValidationPipe(z.string().trim().min(1).max(120))) flagKey: string,
    @Query('userId', new ZodValidationPipe(z.uuid().optional())) userId?: string,
  ) {
    return this.config.flagRows(request.headers.authorization, flagKey, userId);
  }

  @Post(':key/targeting')
  setFlagTargeting(
    @Req() request: AuthedRequest,
    @Param('key', new ZodValidationPipe(z.string().trim().min(1).max(120))) flagKey: string,
    @Body(new ZodValidationPipe(SetFlagTargetingBodySchema)) body: Omit<SetFlagTargetingBody, 'flagKey'>,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.config.setFlagTargeting(
      request.headers.authorization, { ...body, flagKey }, idempotencyKey, this.requestId(request),
    );
  }
}
