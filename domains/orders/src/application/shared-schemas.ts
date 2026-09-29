import { z } from 'zod';

/** Shared actor shape for orders commands; mirrors `@pss/audit`'s AuditEntryInputSchema actor. */
export const ActorInputSchema = z.strictObject({
  userId: z.uuid().optional(),
  roles: z.array(z.string().min(1)),
  serviceIdentity: z.string().min(1).optional(),
}).refine((actor) => actor.userId !== undefined || actor.serviceIdentity !== undefined, 'An actor is required.');

export type ActorInput = z.input<typeof ActorInputSchema>;
