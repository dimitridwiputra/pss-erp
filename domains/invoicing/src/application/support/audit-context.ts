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
