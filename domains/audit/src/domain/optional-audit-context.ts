import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditEntryInputSchema } from './audit-entry';

/**
 * The audit context a command carries through to its audit entry, as an optional shape.
 *
 * A command is often invoked with no per-request actor: a seed, a worker replaying a queue, another
 * domain sharing a transaction. The audit entry is still mandatory (AGENTS.md §14), so the fields are
 * optional here and `resolveAuditContext` fills the gap — with a named service identity rather than
 * an unattributed entry, because `audit_entry_actor_required` would refuse the insert anyway and an
 * anonymous mutation is exactly what §14 exists to prevent.
 *
 * This shape is **derived** from `AuditEntryInputSchema`, not restated, so an actor field added to the
 * entry cannot be silently missing from a command that supplies context. Three domains carried a
 * local copy of this — `inventory`, `master-data`, and `commercial` — which is the same drift ADR-0013
 * found in `withConnection`, and one of them (`domains/wms`) is frozen for the MVP so its copy cannot
 * be removed yet; when that freeze lifts, its `application/support/audit-context.ts` should re-export
 * from here like the others did.
 */
export const OptionalAuditContextSchema = z.strictObject({
  actor: AuditEntryInputSchema.shape.actor.optional(),
  requestId: AuditEntryInputSchema.shape.requestId.optional(),
  correlationId: AuditEntryInputSchema.shape.correlationId.optional(),
  source: AuditEntryInputSchema.shape.source.optional(),
});

export type OptionalAuditContext = z.infer<typeof OptionalAuditContextSchema>;

/**
 * The actor and source shapes, re-exported because a caller that composes its own audit context out
 * of them (`domains/inventory`'s `reserveStock`) should use this domain's definitions rather than
 * restate them.
 */
export const ActorInputSchema = AuditEntryInputSchema.shape.actor;
export const SourceSchema = AuditEntryInputSchema.shape.source;

export type AuditActorInput = z.input<typeof AuditEntryInputSchema.shape.actor>;

export type AuditSource = z.infer<typeof AuditEntryInputSchema.shape.source>;

export interface ResolvedAuditContext {
  actor: AuditActorInput;
  requestId: string;
  correlationId: string;
  source: AuditSource;
}

/**
 * `fallbackCorrelationId` is the aggregate the command is about, so a caller that did not thread a
 * correlation id still gets one that points at the fact the entry describes — a UUID would satisfy
 * the column and tell an auditor nothing.
 */
export function resolveAuditContext(
  context: OptionalAuditContext,
  fallbackCorrelationId: string,
): ResolvedAuditContext {
  return {
    actor: context.actor ?? { roles: [], serviceIdentity: 'pss-command-runner' },
    requestId: context.requestId ?? randomUUID(),
    correlationId: context.correlationId ?? fallbackCorrelationId,
    source: context.source ?? 'SYSTEM',
  };
}
