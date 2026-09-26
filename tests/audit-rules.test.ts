import { describe, expect, it } from 'vitest';
import { AuditEntryInputSchema } from '../domains/audit/src/domain/audit-entry';
import { redactAuditChanges } from '../domains/audit/src/domain/rules/redact-audit-changes';

describe('AUD-001 input and privacy rules', () => {
  it('redacts classified fields, common sensitive paths, and secrets embedded in text', () => {
    expect(redactAuditChanges([
      { path: 'customer.nik', classification: 'INTERNAL', before: '3273010101010001' },
      { path: 'bankAccountNumber', classification: 'INTERNAL', after: '1234567890' },
      { path: 'displayName', classification: 'PERSONAL', after: 'Budi' },
      { path: 'status', classification: 'INTERNAL', after: 'BearER abc.def' },
    ])).toEqual([
      { path: 'customer.nik', classification: 'INTERNAL', before: '[REDACTED]' },
      { path: 'bankAccountNumber', classification: 'INTERNAL', after: '[REDACTED]' },
      { path: 'displayName', classification: 'PERSONAL', after: '[REDACTED]' },
      { path: 'status', classification: 'INTERNAL', after: '[REDACTED]' },
    ]);
  });

  it('rejects entries without an actor and unclassified changes', () => {
    const entry = {
      organizationId: 'b10e68e1-651f-4972-8e34-6c4e6cd0ee53',
      actor: { roles: [] }, action: 'EXAMPLE_CHANGED',
      entity: { domain: 'audit', type: 'example', id: 'b10e68e1-651f-4972-8e34-6c4e6cd0ee54', version: 1 },
      changes: [{ path: 'status', after: 'new' }], requestId: 'request-1', correlationId: 'correlation-1', source: 'API',
    };
    expect(AuditEntryInputSchema.safeParse(entry).success).toBe(false);
  });
});
