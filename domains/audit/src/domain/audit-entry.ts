import { z } from 'zod';

export const AuditChangeSchema = z.strictObject({
  path: z.string().min(1),
  classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'SENSITIVE_PERSONAL']),
  before: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  after: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
}).refine((change) => change.before !== undefined || change.after !== undefined, 'A before or after value is required.');

export const AuditEntryInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  actor: z.strictObject({
    userId: z.uuid().optional(),
    roles: z.array(z.string().min(1)).default([]),
    onBehalfOf: z.uuid().optional(),
    serviceIdentity: z.string().min(1).optional(),
  }).refine((actor) => actor.userId !== undefined || actor.serviceIdentity !== undefined, 'An actor is required.'),
  action: z.string().min(1),
  entity: z.strictObject({
    domain: z.string().min(1),
    type: z.string().min(1),
    id: z.uuid(),
    version: z.number().int().positive(),
  }),
  changes: z.array(AuditChangeSchema).min(1),
  reasonCode: z.string().min(1).optional(),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});

export type AuditEntryInput = z.input<typeof AuditEntryInputSchema>;
export type AuditChange = z.output<typeof AuditChangeSchema>;
