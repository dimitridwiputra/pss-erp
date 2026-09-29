import { describe, expect, it } from 'vitest';
// The workspace root does not declare zod, so it is resolved through the package that
// owns the dependency. Both paths point at the same pnpm store entry (zod 4.6.5).
import { z } from '../packages/http/node_modules/zod';
import { AuditChangeSchema } from '../domains/audit/src/domain/audit-entry';
import {
  classified,
  classifiedFieldsOf,
  classificationOf,
  fieldClassifications,
  FieldClassificationSchema,
  hasViewFullPermission,
  isMaskedClassification,
  maskClassifiedRecord,
  maskSensitiveValue,
  presentSensitiveField,
  presentSensitiveValue,
  unclassifiedPersonalFields,
} from '../packages/http/src/field-classification';

/** A contract shaped like a customer response: every personal field must be classified. */
const CustomerResponseSchema = z.strictObject({
  id: z.uuid(),
  name: classified(z.string(), 'PERSONAL'),
  phone: classified(z.string().optional(), 'PERSONAL'),
  nik: classified(z.string(), 'SENSITIVE_PERSONAL'),
  npwp: classified(z.string().nullable(), 'SENSITIVE_PERSONAL'),
  status: classified(z.enum(['ACTIVE', 'INACTIVE']), 'INTERNAL'),
  creditLimit: classified(z.string(), 'CONFIDENTIAL'),
  addresses: classified(z.array(z.string()), 'PERSONAL'),
});

const personalFieldPattern = /^(?:name|phone|nik|npwp|email|address)/i;

describe('SEC-001 field classification', () => {
  it('SEC-001.AC03 reuses the audit change vocabulary rather than declaring a second one', () => {
    expect([...FieldClassificationSchema.options]).toEqual([...fieldClassifications]);
    expect([...FieldClassificationSchema.options]).toEqual([...AuditChangeSchema.shape.classification.options]);
  });

  it('round-trips a classification through a contract schema', () => {
    const parsed = CustomerResponseSchema.parse({
      id: '0195f0c1-7c1e-7000-8000-000000000002',
      name: 'Budi Santoso',
      phone: '081234567890',
      nik: '3174010101010001',
      npwp: null,
      status: 'ACTIVE',
      creditLimit: '50000000',
      addresses: ['Jl. Merdeka 1'],
    });
    expect(parsed.nik).toBe('3174010101010001');
    expect(classificationOf(CustomerResponseSchema.shape.nik)).toBe('SENSITIVE_PERSONAL');
    // Re-validating a parsed value must not change the declared classification.
    expect(CustomerResponseSchema.parse(parsed).nik).toBe('3174010101010001');
  });

  it('SEC-001.R05 derives the personal-data map from the schema itself', () => {
    expect(classifiedFieldsOf(CustomerResponseSchema)).toEqual({
      name: 'PERSONAL',
      phone: 'PERSONAL',
      nik: 'SENSITIVE_PERSONAL',
      npwp: 'SENSITIVE_PERSONAL',
      status: 'INTERNAL',
      creditLimit: 'CONFIDENTIAL',
      addresses: 'PERSONAL',
    });
    expect(classifiedFieldsOf(CustomerResponseSchema).id).toBeUndefined();
  });

  it('SEC-001.AC03 finds a personal field that carries no classification', () => {
    const IncompleteSchema = z.strictObject({
      nik: z.string(),
      email: z.string(),
      name: classified(z.string(), 'PERSONAL'),
    });
    expect(unclassifiedPersonalFields(IncompleteSchema, personalFieldPattern)).toEqual(['nik', 'email']);
    expect(unclassifiedPersonalFields(CustomerResponseSchema, personalFieldPattern)).toEqual([]);
  });

  it('marks only the personal and sensitive classifications as maskable', () => {
    expect(isMaskedClassification('PERSONAL')).toBe(true);
    expect(isMaskedClassification('SENSITIVE_PERSONAL')).toBe(true);
    expect(isMaskedClassification('CONFIDENTIAL')).toBe(false);
    expect(isMaskedClassification('INTERNAL')).toBe(false);
    expect(isMaskedClassification('PUBLIC')).toBe(false);
  });
});

describe('SEC-001 masking', () => {
  it('SEC-001.AC01 keeps only the last four characters', () => {
    expect(maskSensitiveValue('3174010101010001')).toBe('************0001');
    expect(maskSensitiveValue('1234567890')).toBe('******7890');
    expect(maskSensitiveValue('081234567890')).toBe('********7890');
  });

  it('never returns a short value in full, and leaves an empty value empty', () => {
    // A value no longer than visibleLast still loses at least one character.
    expect(maskSensitiveValue('1234')).toBe('*234');
    expect(maskSensitiveValue('123')).toBe('*23');
    expect(maskSensitiveValue('1')).toBe('*');
    expect(maskSensitiveValue('')).toBe('');
    expect(maskSensitiveValue('12345', { visibleLast: 0 })).toBe('*****');
  });

  it('rejects a mask configuration that would defeat masking', () => {
    expect(() => maskSensitiveValue('3174010101010001', { maskCharacter: '' })).toThrow(/maskCharacter/);
    expect(() => maskSensitiveValue('3174010101010001', { visibleLast: -1 })).toThrow(/visibleLast/);
  });

  it('supports the fixed-width bank-account mask from BNK-001.AC02', () => {
    expect(maskSensitiveValue('1234567890', { maskCharacter: '•', maskLength: 4 })).toBe('••••7890');
    expect(maskSensitiveValue('1234567890123', { maskCharacter: '•', maskLength: 4 })).toBe('••••0123');
  });

  it('SEC-001.BR02 reveals the full value only with the view_full permission', () => {
    const hidden = presentSensitiveValue('3174010101010001', {
      canViewFull: false,
      requiredPermission: 'master_data.customer.identity.view_full',
    });
    expect(hidden).toEqual({
      value: '************0001',
      masked: true,
      requiredPermission: 'master_data.customer.identity.view_full',
    });

    const shown = presentSensitiveValue('3174010101010001', {
      canViewFull: true,
      requiredPermission: 'master_data.customer.identity.view_full',
    });
    expect(shown).toEqual({
      value: '3174010101010001',
      masked: false,
      requiredPermission: 'master_data.customer.identity.view_full',
    });
  });

  it('maps the kind to its Appendix D.3 permission and honours wildcard grants', () => {
    expect(presentSensitiveField('NIK', '3174010101010001', []).value).toBe('************0001');
    expect(presentSensitiveField('BANK_ACCOUNT', '1234567890', ['finance.bank.account.view_full']).value).toBe('1234567890');
    expect(presentSensitiveField('BANK_ACCOUNT', '1234567890', ['master_data.customer.identity.view_full']).masked).toBe(true);
    expect(hasViewFullPermission(['customer.identity.view_full'], 'master_data.customer.identity.view_full')).toBe(false);
    expect(hasViewFullPermission(['master_data.customer.identity.view_full'], 'master_data.customer.identity.view_full')).toBe(true);
    expect(hasViewFullPermission([], 'master_data.customer.identity.view_full')).toBe(false);
  });

  it('SEC-001.R03 masks only the classified string fields of a record', () => {
    const record = maskClassifiedRecord(
      { id: 'customer-1', name: 'Budi Santoso', nik: '3174010101010001', creditLimit: '50000000' },
      classifiedFieldsOf(CustomerResponseSchema),
    );
    expect(record).toEqual({
      id: 'customer-1',
      name: '********toso',
      nik: '************0001',
      creditLimit: '50000000',
    });
  });
});
