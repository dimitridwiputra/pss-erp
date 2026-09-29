import { z } from 'zod';

/**
 * SEC-001 field classification and masking (PRD §77, §78).
 *
 * Domain owner: Platform. This module owns no business rule; it owns the *vocabulary* and
 * the *mechanism* that lets a contract schema declare how a field may be shown, logged, and
 * exported. Masking must happen before a value is written anywhere (OBS-001.BR03).
 *
 * Ownership note: the same five classifications already exist as
 * `AuditChangeSchema.shape.classification` in `@pss/audit`
 * (`domains/audit/src/domain/audit-entry.ts`). That domain owns the *audit* use of the
 * vocabulary; it must not be imported from a package (PLT-002 forbids packages importing
 * domains), so the two declarations are kept in lockstep by a parity test in
 * `tests/sec-001-field-classification.test.ts`. Moving the single declaration to
 * `@pss/contracts` is the intended end state and is tracked as an open decision.
 */

export const fieldClassifications = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'SENSITIVE_PERSONAL'] as const;
export type FieldClassification = (typeof fieldClassifications)[number];

export const FieldClassificationSchema = z.enum(fieldClassifications);

/** Classifications whose value must never leave the server in full by default. */
export const maskedClassifications: readonly FieldClassification[] = ['PERSONAL', 'SENSITIVE_PERSONAL'];

export function isMaskedClassification(classification: FieldClassification): boolean {
  return maskedClassifications.includes(classification);
}

const classificationMetadataKey = 'pssClassification';

/**
 * Mark a contract field as classified.
 *
 * The annotation travels with the schema through `.optional()`, `.nullable()`, and
 * `.array()`, so a field declared inline in a request or response contract keeps its
 * classification when composed. `classificationOf` reads it back.
 */
export function classified<T extends z.ZodType>(schema: T, classification: FieldClassification): T {
  return schema.meta({ [classificationMetadataKey]: classification }) as T;
}

export function classificationOf(schema: z.ZodType): FieldClassification | undefined {
  const found = z.globalRegistry.get(schema) as Record<string, unknown> | undefined;
  const value = found?.[classificationMetadataKey];
  return typeof value === 'string' && (fieldClassifications as readonly string[]).includes(value)
    ? value as FieldClassification : undefined;
}

/**
 * Unwrap `optional` / `nullable` / `default` / `array` wrappers around a field schema so
 * the classification declared on the inner value is found. A union or object stops the
 * walk, because a classification on a composite shape is not a classification of the
 * field's value.
 */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (classificationOf(current) !== undefined) return current;
    if (!('unwrap' in current) || typeof current.unwrap !== 'function') return current;
    current = current.unwrap();
  }
  return current;
}

export type ClassifiedFields = Readonly<Record<string, FieldClassification>>;

/**
 * SEC-001.R05: the personal-data map, derived from the contract schemas themselves rather
 * than maintained by hand. Feed it the object schemas of a request/response contract and
 * every classified field is listed with its classification.
 */
export function classifiedFieldsOf(objectSchema: z.ZodObject): ClassifiedFields {
  const shape = objectSchema.shape as Record<string, z.ZodType>;
  const fields: Record<string, FieldClassification> = {};
  for (const [name, schema] of Object.entries(shape)) {
    const classification = classificationOf(unwrapSchema(schema));
    if (classification) fields[name] = classification;
  }
  return fields;
}

/** SEC-001.AC03: the fields of a contract that look personal but carry no classification. */
export function unclassifiedPersonalFields(
  objectSchema: z.ZodObject,
  personalFieldPattern: RegExp,
): string[] {
  const classified = classifiedFieldsOf(objectSchema);
  return Object.keys(objectSchema.shape as Record<string, unknown>)
    .filter((name) => personalFieldPattern.test(name) && !classified[name]);
}

// --- Masking (SEC-001.BR02, PRD §78 PRV.R04) ---------------------------------------------

export type MaskOptions = {
  /** How many trailing characters stay visible. PRD PRV.R04 fixes this at 4. */
  visibleLast?: number;
  /** Defaults to `*`, the character in the SEC-001 copy example. */
  maskCharacter?: string;
  /** `preserve` keeps the value's length; a number pads the mask to a fixed width. */
  maskLength?: 'preserve' | number;
};

export const defaultMaskOptions: Required<MaskOptions> = {
  visibleLast: 4,
  maskCharacter: '*',
  maskLength: 'preserve',
};

/**
 * SEC-001.AC01: reveal only the last `visibleLast` characters, and always mask at least
 * one character so a short value is never returned in full. An empty value stays empty
 * so a missing field is not turned into a row of asterisks.
 */
export function maskSensitiveValue(value: string, options: MaskOptions = {}): string {
  const { visibleLast, maskCharacter, maskLength } = { ...defaultMaskOptions, ...options };
  if (maskCharacter.length === 0) throw new Error('maskCharacter must be at least one character.');
  if (!Number.isInteger(visibleLast) || visibleLast < 0) throw new Error('visibleLast must be a non-negative integer.');
  if (value.length === 0) return '';
  const visibleCount = Math.min(visibleLast, value.length - 1);
  const visible = visibleCount > 0 ? value.slice(value.length - visibleCount) : '';
  const width = maskLength === 'preserve' ? value.length - visible.length : maskLength;
  return maskCharacter.repeat(Math.max(0, width)) + visible;
}

export type SensitiveValuePresentation = {
  value: string;
  masked: boolean;
  /** The permission that would have revealed the full value, for the "Tampilkan" affordance. */
  requiredPermission?: string;
};

/**
 * SEC-001.AC01/AC02: return the full value only when the caller holds the
 * `*.view_full` permission for that kind of data, otherwise the masked form. The caller is
 * responsible for the audit entry recording a full-value read (SEC-001.BR02).
 */
export function presentSensitiveValue(
  value: string,
  view: { canViewFull: boolean; requiredPermission: string; options?: MaskOptions },
): SensitiveValuePresentation {
  if (view.canViewFull) return { value, masked: false, requiredPermission: view.requiredPermission };
  return {
    value: maskSensitiveValue(value, view.options),
    masked: true,
    requiredPermission: view.requiredPermission,
  };
}

/**
 * Appendix D.3 registers `*.view_full` per kind of sensitive data, for example
 * `master_data.customer.identity.view_full` and `finance.bank.account.view_full`.
 */
export function hasViewFullPermission(granted: readonly string[], requiredPermission: string): boolean {
  if (granted.includes(requiredPermission)) return true;
  const requiredPrefix = requiredPermission.replace(/\.view_full$/, '');
  return granted.some((permission) => permission.endsWith('.view_full') && permission.replace(/\.view_full$/, '') === requiredPrefix);
}

export type SensitiveDataKind = 'NIK' | 'NPWP' | 'BANK_ACCOUNT' | 'PHONE';

/** Appendix D.3 §77 names the `*.view_full` permissions; the kind-to-permission map is configuration. */
export const viewFullPermissionByKind: Readonly<Record<SensitiveDataKind, string>> = {
  NIK: 'master_data.customer.identity.view_full',
  NPWP: 'master_data.customer.identity.view_full',
  BANK_ACCOUNT: 'finance.bank.account.view_full',
  PHONE: 'master_data.customer.contact.view_full',
};

export function presentSensitiveField(
  kind: SensitiveDataKind,
  value: string,
  grantedPermissions: readonly string[],
  options?: MaskOptions,
): SensitiveValuePresentation {
  const requiredPermission = viewFullPermissionByKind[kind];
  return presentSensitiveValue(value, {
    canViewFull: hasViewFullPermission(grantedPermissions, requiredPermission),
    requiredPermission,
    ...(options ? { options } : {}),
  });
}

/**
 * SEC-001.R03: mask every value of a record according to its classification before the
 * record reaches a log line, an export, or the data warehouse (PRV.R06).
 */
export function maskClassifiedRecord(
  record: Readonly<Record<string, unknown>>,
  fields: ClassifiedFields,
  options?: MaskOptions,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([name, value]) => {
    const classification = fields[name];
    if (!classification || !isMaskedClassification(classification) || typeof value !== 'string') return [name, value];
    return [name, maskSensitiveValue(value, options)];
  }));
}
