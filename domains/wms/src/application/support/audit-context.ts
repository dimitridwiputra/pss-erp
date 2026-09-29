import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Mirrors `@pss/audit`'s `AuditEntryInputSchema` actor shape without importing its Zod schema directly. */
export const ActorInputSchema = z.strictObject({
  userId: z.uuid().optional(),
  roles: z.array(z.string().min(1)),
  serviceIdentity: z.string().min(1).optional(),
});

// WMS-014.R02: OFFLINE (queued while a handheld device had no connection) and PAPER (manually
// re-entered after a paper fallback) are real, distinguishable sources for this domain.
export const SourceSchema = z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT', 'OFFLINE', 'PAPER']);

export type ActorInput = z.infer<typeof ActorInputSchema>;
export type Source = z.infer<typeof SourceSchema>;

/** Optional audit-trail context a caller may thread through a shared transaction. */
export const OptionalAuditContextSchema = z.strictObject({
  actor: ActorInputSchema.optional(),
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  source: SourceSchema.optional(),
});

export type OptionalAuditContext = z.infer<typeof OptionalAuditContextSchema>;

/**
 * Most handheld WMS confirmations (scan-driven, PSS Gudang) always carry a real device actor, but
 * a few flows (opening-count reconciliation triggered from an admin screen, a system sweep) may
 * not. When the caller does not supply one, attribute the audit entry to a system identity rather
 * than leaving the mandatory audit trail (AGENTS.md §14) unattributed.
 */
export function resolveAuditContext(
  context: OptionalAuditContext,
  fallbackCorrelationId: string,
): { actor: ActorInput; requestId: string; correlationId: string; source: Source } {
  return {
    actor: context.actor ?? { roles: [], serviceIdentity: 'wms-domain' },
    requestId: context.requestId ?? randomUUID(),
    correlationId: context.correlationId ?? fallbackCorrelationId,
    source: context.source ?? 'SYSTEM',
  };
}
