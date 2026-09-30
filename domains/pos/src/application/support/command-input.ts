import { DomainError, registryCatalog } from '@pss/contracts';
import { z } from 'zod';

/** Mirrors `@pss/audit`'s actor shape; the caller resolves it from the session, never the body. */
export const ActorSchema = z.strictObject({
  userId: z.uuid().optional(),
  roles: z.array(z.string()).default([]),
  serviceIdentity: z.string().optional(),
});

/** Request context every command threads into its audit entry and events. */
export const RequestMetaShape = {
  actor: ActorSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
};

/** Non-negative money with at most 2 places; arithmetic on it happens in Postgres, never in JS. */
export const MoneyInputSchema = z.string().regex(/^\d+(\.\d{1,2})?$/);
/** Positive quantity with at most 3 places. */
export const QuantityInputSchema = z.string().regex(/^\d+(\.\d{1,3})?$/)
  .refine((value) => !/^0+(\.0+)?$/.test(value), 'Jumlah harus lebih dari nol.');

export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const posReasonCodes: ReadonlySet<string> = new Set(registryCatalog.reasonCodes.filter((reason) => reason.area === 'POS').map((reason) => reason.code));

/** A shift-close variance is explained by a registered Appendix F reason code of area POS. */
export function assertPosReasonCode(reasonCode: string | undefined, path: string): void {
  if (reasonCode !== undefined && !posReasonCodes.has(reasonCode)) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path, code: 'invalid_value', message: 'Pilih alasan yang tersedia.' }]);
  }
}

/** The business date a counter action belongs to (AGENTS.md §11.1: interpreted in Asia/Jakarta). */
export function jakartaBusinessDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
