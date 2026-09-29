import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Mirrors `@pss/audit`'s `AuditEntryInputSchema` actor shape without importing its Zod schema directly. */
export const ActorInputSchema = z.strictObject({
  userId: z.uuid().optional(),
  roles: z.array(z.string().min(1)),
  serviceIdentity: z.string().min(1).optional(),
});

export const SourceSchema = z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']);

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
 * `releaseReservation` and `issueInventory` are fulfilment-side commands that may run with no
 * per-request actor available (e.g. an automated reservation-expiry sweep). When the caller
 * does not supply one, attribute the audit entry to a system identity rather than leaving the
 * mandatory audit trail (AGENTS.md §14) unattributed. A caller that has real actor/request
 * context (e.g. domains/pos handling an explicit cashier cancellation) should always pass it.
 */
export function resolveAuditContext(
  context: OptionalAuditContext,
  fallbackCorrelationId: string,
): { actor: ActorInput; requestId: string; correlationId: string; source: Source } {
  return {
    actor: context.actor ?? { roles: [], serviceIdentity: 'inventory-domain' },
    requestId: context.requestId ?? randomUUID(),
    correlationId: context.correlationId ?? fallbackCorrelationId,
    source: context.source ?? 'SYSTEM',
  };
}
