import { z } from 'zod';
import { auditRetentionClasses, defaultAuditRetentionClass } from './retention-policy';

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
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT', 'OFFLINE', 'PAPER']),
  /**
   * OD-19 retention class, declared by the calling domain rather than inferred here.
   *
   * The audit domain cannot know that a journal post is FINANCIAL and a session login is SECURITY:
   * that is the owning domain's knowledge of its own fact, and inferring it from the action name
   * would put a policy table of action prefixes in this domain, which is a duplicate system. Absent a
   * declaration the entry takes the default class, which is the middle of the range so that a caller
   * which forgets over-retains rather than destroys a record.
   */
  retentionClass: z.enum(auditRetentionClasses).default(defaultAuditRetentionClass),
});

export type AuditEntryInput = z.input<typeof AuditEntryInputSchema>;
export type AuditChange = z.output<typeof AuditChangeSchema>;
