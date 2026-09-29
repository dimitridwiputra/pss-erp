import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { type AuditedTransaction } from '@pss/audit';
import { BUSINESS_TIME_ZONE } from './business-calendar';
import { withConnection } from './command';

/**
 * DOC-001 — document numbering per (document type, scope, business period).
 *
 * What this module owns: the counter, the reservation record, and the guarantee that a number
 * is never handed out twice. What it deliberately does not own: the numbering format.
 *
 * GAP-16 (open, validated by Finance/Tax) has not approved the pattern, the padding, the gap
 * policy per type, or the official branch code. The schema therefore stores those as NULL and
 * `reserveDocumentNumber` reports `formattedNumber: null` / `formatted: false` until an
 * approved `pattern` exists. It never falls back to a hard-coded format and never derives a
 * branch code: `branch_code` comes from the scheme, written by an operator who holds the
 * approved code. Baking `{TYPE}-{BRANCH}-{YYYY}-{NNNNN}` into this file would turn GAP-16
 * into a constant, which is the exact failure the open decision exists to prevent.
 */

const DocTypeSchema = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/);

const CreateSchemeSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Absent means an organization-level document type (DOC-001.A2, e.g. a journal voucher). */
  branchId: z.uuid().optional(),
  docType: DocTypeSchema,
  /** DRAFT by default. See `createNumberingScheme` for why activating one is the operator's
   * decision about an approved format rather than Platform's. */
  status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
  pattern: z.string().trim().min(1).max(120).optional(),
  branchCode: z.string().trim().min(1).max(20).optional(),
  resetPolicy: z.enum(['YEARLY', 'MONTHLY', 'NEVER']).optional(),
  gapPolicy: z.enum(['NO_GAP_FISCAL', 'GAP_ALLOWED']).optional(),
  padding: z.int().min(1).max(20).optional(),
  startAt: z.int().min(1).default(1),
  validFrom: z.iso.date(),
  requestId: z.string().min(1),
});
export type CreateSchemeInput = z.input<typeof CreateSchemeSchema>;

const SeedDraftsSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  /** The business date the DRAFT schemes are registered from. Defaults to the Jakarta business date. */
  validFrom: z.iso.date().optional(),
  requestId: z.string().min(1),
});
export type SeedDraftSchemesInput = z.input<typeof SeedDraftsSchema>;

const ReserveSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  docType: DocTypeSchema,
  /** The document's own Asia/Jakarta business date, never the server date (DOC-001.BR05/AC04). */
  documentDate: z.iso.date(),
  requestKey: z.string().trim().min(1).max(200),
  requestingDomain: z.string().trim().min(1).max(50),
  reservedBy: z.uuid().optional(),
  requestId: z.string().min(1),
});
export type ReserveNumberInput = z.input<typeof ReserveSchema>;

const ConfirmSchema = z.strictObject({
  organizationId: z.uuid(),
  reservationId: z.uuid(),
  documentId: z.string().trim().min(1).max(200),
  requestId: z.string().min(1),
});
export type ConfirmNumberInput = z.input<typeof ConfirmSchema>;

const VoidSchema = z.strictObject({
  organizationId: z.uuid(),
  reservationId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  voidedBy: z.uuid().optional(),
  requestId: z.string().min(1),
});
export type VoidNumberInput = z.input<typeof VoidSchema>;

export interface DocumentNumber {
  reservationId: string;
  docType: string;
  organizationId: string;
  branchId: string | null;
  documentDate: string;
  businessYear: number;
  businessMonth: number | null;
  periodKey: string;
  /** The allocated ordinal inside the period. Never reused, even after a VOID. */
  sequenceValue: string;
  /** Null while GAP-16 leaves the pattern unapproved; never a fabricated default. */
  formattedNumber: string | null;
  status: 'RESERVED' | 'CONFIRMED' | 'VOID';
  /** False when the scheme has no approved pattern, so no caller presents it as final. */
  formatted: boolean;
}

interface ReservationRow {
  id: string;
  organization_id: string;
  branch_id: string | null;
  doc_type: string;
  document_date: string;
  document_id: string | null;
  business_year: number;
  business_month: number | null;
  period_key: string;
  sequence_value: string;
  formatted_number: string | null;
  status: 'RESERVED' | 'CONFIRMED' | 'VOID';
  version: number;
}

function toDocumentNumber(row: ReservationRow): DocumentNumber {
  return {
    reservationId: row.id,
    docType: row.doc_type,
    organizationId: row.organization_id,
    branchId: row.branch_id,
    documentDate: row.document_date,
    businessYear: row.business_year,
    businessMonth: row.business_month,
    periodKey: row.period_key,
    sequenceValue: row.sequence_value,
    formattedNumber: row.formatted_number,
    status: row.status,
    formatted: row.formatted_number !== null,
  };
}

/** §11: the business date is the Indonesian calendar day, not the UTC server day. */
function jakartaBusinessDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** DOC-001.BR05: the period comes from the document's own business date (Asia/Jakarta). */
function periodFor(
  resetPolicy: 'YEARLY' | 'MONTHLY' | 'NEVER', businessDate: string,
): { periodKey: string; businessYear: number; businessMonth: number | null } {
  const parts = businessDate.split('-');
  const year = Number.parseInt(parts[0] ?? '', 10);
  const month = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new DomainError('VALIDATION_FAILED');
  if (resetPolicy === 'YEARLY') return { periodKey: `Y:${year}`, businessYear: year, businessMonth: null };
  if (resetPolicy === 'MONTHLY') {
    return { periodKey: `M:${year}-${String(month).padStart(2, '0')}`, businessYear: year, businessMonth: month };
  }
  return { periodKey: 'A', businessYear: year, businessMonth: null };
}

function formatNumber(
  pattern: string, branchCode: string | null, padding: number,
  docType: string, period: { businessYear: number; businessMonth: number | null }, sequenceValue: string,
): string {
  return pattern
    .replaceAll('{TYPE}', docType)
    .replaceAll('{BRANCH}', branchCode ?? '')
    .replaceAll('{YYYY}', String(period.businessYear))
    .replaceAll('{MM}', period.businessMonth === null ? '' : String(period.businessMonth).padStart(2, '0'))
    .replaceAll('{SEQ}', sequenceValue.padStart(padding, '0'));
}

/**
 * DOC-001.E2. Padding is an operator-supplied part of the approved scheme, so the largest
 * ordinal the format can express is a property of registered data rather than an invented
 * business rule. Exhausting it is `NUMBERING_EXHAUSTED`; the operator must then widen the
 * padding with a new effective-dated scheme (DOC-001.BR06 leaves issued numbers untouched).
 */
function assertNotExhausted(sequenceValue: string, padding: number): void {
  const maximum = 10 ** padding - 1;
  if (BigInt(sequenceValue) > BigInt(maximum)) throw new DomainError('NUMBERING_EXHAUSTED');
}

const RESERVATION_COLUMNS = `id, organization_id, branch_id, doc_type,
  document_date::text AS document_date, business_year, business_month, period_key,
  sequence_value::text AS sequence_value, formatted_number, document_id, status, version`;

interface SchemeRow {
  id: string;
  pattern: string | null;
  branch_code: string | null;
  reset_policy: 'YEARLY' | 'MONTHLY' | 'NEVER' | null;
  padding: number | null;
  start_at: string;
}

async function loadActiveScheme(
  client: PoolClient, organizationId: string, branchId: string | undefined,
  docType: string, businessDate: string,
): Promise<SchemeRow> {
  const { rows } = await client.query<SchemeRow>(
    `SELECT id, pattern, branch_code, reset_policy, padding, start_at::text AS start_at
     FROM platform.document_numbering_scheme
     WHERE organization_id = $1
       AND coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) =
           coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND doc_type = $3
       AND status = 'ACTIVE'
       AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to > $4::date)
     ORDER BY valid_from DESC LIMIT 1`,
    [organizationId, branchId ?? null, docType, businessDate],
  );
  const scheme = rows[0];
  if (!scheme) throw new DomainError('NOT_FOUND');
  // Without a reset policy there is no period to key a counter on. Refusing is the only option
  // that does not guess YEARLY on the caller's behalf.
  if (scheme.reset_policy === null || scheme.pattern === null || scheme.padding === null) {
    throw new DomainError('INVALID_STATE_TRANSITION');
  }
  return scheme;
}

/**
 * DOC-001.R01/R02/AC01/AC02. The counter row is locked and incremented inside the same
 * transaction as the reservation insert, so concurrent callers serialize on it and a rollback
 * releases the ordinal with the rest of the work. The same `requestKey` returns the identical
 * reservation instead of allocating a second number.
 */
export async function reserveDocumentNumber(
  pool: Pool, rawInput: ReserveNumberInput, transaction?: AuditedTransaction,
): Promise<{ number: DocumentNumber; replayed: boolean }> {
  const parsed = ReserveSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  // `withConnection` reuses the caller's open transaction when there is one. The previous
  // `if (transaction) return runReserve(transaction.client, ...)` short-circuit skipped
  // `runAuditedWork`, so a caller-supplied transaction was not checked for an audit entry.
  return withConnection(pool, transaction?.client, async ({ client, appendAuditEntry }) => {
    const { number, replayed } = await runReserve(client, appendAuditEntry, input);
    if (replayed) {
      // The audit wrapper refuses to commit without an entry, and a caller retrying a reserve
      // is exactly the case a fiscal auditor will ask about. Recording the replay keeps that
      // answer in the trail without inventing a new reservation state.
      await appendAuditEntry({
        organizationId: input.organizationId,
        ...(input.branchId ? { branchId: input.branchId } : {}),
        actor: { userId: input.reservedBy, serviceIdentity: `domain:${input.requestingDomain}`, roles: [] },
        action: 'DOCUMENT_NUMBER_RESERVED',
        entity: { domain: 'platform', type: 'NumberReservation', id: number.reservationId, version: 1 },
        changes: [{ path: 'replay', classification: 'INTERNAL', after: input.requestKey }],
        requestId: input.requestId, correlationId: input.requestId, source: 'SYSTEM',
      });
    }
    return { number, replayed };
  });
}

async function runReserve(
  client: PoolClient,
  appendAuditEntry: AuditedTransaction['appendAuditEntry'],
  input: z.output<typeof ReserveSchema>,
): Promise<{ number: DocumentNumber; replayed: boolean }> {
  const existing = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM platform.document_number_reservation
     WHERE organization_id = $1
       AND coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) =
           coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND doc_type = $3 AND request_key = $4`,
    [input.organizationId, input.branchId ?? null, input.docType, input.requestKey],
  );
  const prior = existing.rows[0];
  if (prior) return { number: toDocumentNumber(prior), replayed: true };

  const scheme = await loadActiveScheme(client, input.organizationId, input.branchId, input.docType, input.documentDate);
  const period = periodFor(scheme.reset_policy!, input.documentDate);
  // The row lock is what makes parallel reserves produce distinct ordinals: each caller
  // waits, reads the post-increment value, and commits in order.
  await client.query(
    `INSERT INTO platform.document_number_sequence (id, scheme_id, period_key, last_value)
     VALUES ($1, $2, $3, $4::bigint)
     ON CONFLICT (scheme_id, period_key) DO NOTHING`,
    [randomUUID(), scheme.id, period.periodKey, BigInt(scheme.start_at) - 1n],
  );
  const allocated = await client.query<{ last_value: string }>(
    `UPDATE platform.document_number_sequence SET last_value = last_value + 1, updated_at = now()
     WHERE scheme_id = $1 AND period_key = $2
     RETURNING last_value::text AS last_value`,
    [scheme.id, period.periodKey],
  );
  const sequenceValue = allocated.rows[0]?.last_value;
  if (sequenceValue === undefined) {
    throw new Error('The document number counter row was not found after insertion.');
  }
  assertNotExhausted(sequenceValue, scheme.padding!);

  const reservationId = randomUUID();
  const inserted = await client.query<ReservationRow>(
    `INSERT INTO platform.document_number_reservation (
       id, organization_id, branch_id, scheme_id, doc_type, document_date, business_year,
       business_month, period_key, sequence_value, formatted_number, request_key,
       requesting_domain, reserved_by, status
     ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10::bigint,$11,$12,$13,$14,'RESERVED')
     RETURNING ${RESERVATION_COLUMNS}`,
    [reservationId, input.organizationId, input.branchId ?? null, scheme.id, input.docType,
      input.documentDate, period.businessYear, period.businessMonth, period.periodKey,
      sequenceValue,
      formatNumber(scheme.pattern!, scheme.branch_code, scheme.padding!, input.docType, period, sequenceValue),
      input.requestKey, input.requestingDomain, input.reservedBy ?? null],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('The document number reservation was not returned after insertion.');
  await appendAuditEntry({
    organizationId: input.organizationId,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    actor: { ...(input.reservedBy ? { userId: input.reservedBy } : {}), serviceIdentity: `domain:${input.requestingDomain}`, roles: [] },
    action: 'DOCUMENT_NUMBER_RESERVED',
    entity: { domain: 'platform', type: 'NumberReservation', id: reservationId, version: 1 },
    changes: [
      { path: 'status', classification: 'INTERNAL', after: 'RESERVED' },
      { path: 'sequenceValue', classification: 'INTERNAL', after: sequenceValue },
      { path: 'periodKey', classification: 'INTERNAL', after: period.periodKey },
      { path: 'formattedNumber', classification: 'INTERNAL', after: row.formatted_number ?? 'UNSET' },
    ],
    requestId: input.requestId, correlationId: input.requestId, source: 'SYSTEM',
  });
  return { number: toDocumentNumber(row), replayed: false };
}

/** DOC-001: RESERVED -> CONFIRMED. A confirmation binds the number to one document. */
export async function confirmDocumentNumber(
  pool: Pool, rawInput: ConfirmNumberInput, transaction?: AuditedTransaction,
): Promise<DocumentNumber> {
  const parsed = ConfirmSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  const run = async (client: PoolClient, audit: AuditedTransaction['appendAuditEntry']) => {
    const { rows } = await client.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM platform.document_number_reservation
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.reservationId, input.organizationId],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status === 'CONFIRMED') {
      // A retry re-reads the same fact. It is still traced, so an auditor asking "was this
      // number confirmed twice?" gets an answer, and the caller's audited transaction keeps
      // its guarantee that no command commits without a record.
      await audit({
        organizationId: input.organizationId,
        actor: { serviceIdentity: 'platform.documents', roles: [] },
        action: 'DOCUMENT_NUMBER_CONFIRMED',
        entity: { domain: 'platform', type: 'NumberReservation', id: input.reservationId, version: row.version },
        changes: [{ path: 'replay', classification: 'INTERNAL', after: row.document_id ?? 'CONFIRMED' }],
        requestId: input.requestId, correlationId: input.requestId, source: 'SYSTEM',
      });
      return toDocumentNumber(row);
    }
    if (row.status !== 'RESERVED') throw new DomainError('INVALID_STATE_TRANSITION');
    const version = row.version + 1;
    const updated = await client.query<ReservationRow>(
      `UPDATE platform.document_number_reservation
       SET status = 'CONFIRMED', document_id = $2, version = $3, updated_at = now()
       WHERE id = $1 RETURNING ${RESERVATION_COLUMNS}`,
      [input.reservationId, input.documentId, version],
    );
    const confirmed = updated.rows[0];
    if (!confirmed) throw new Error('The reservation was not returned after confirmation.');
    await audit({
      organizationId: input.organizationId,
      actor: { serviceIdentity: 'platform.documents', roles: [] },
      action: 'DOCUMENT_NUMBER_CONFIRMED',
      entity: { domain: 'platform', type: 'NumberReservation', id: input.reservationId, version },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'RESERVED', after: 'CONFIRMED' },
        { path: 'documentId', classification: 'INTERNAL', after: input.documentId },
      ],
      requestId: input.requestId, correlationId: input.requestId, source: 'SYSTEM',
    });
    return toDocumentNumber(confirmed);
  };
  return withConnection(pool, transaction?.client, ({ client, appendAuditEntry }) => run(client, appendAuditEntry));
}

/**
 * DOC-001.BR02 / AC03 / NC02 / R05. A void records the actor and the reason and is permanent:
 * the ordinal stays consumed, so the next reservation gets a higher number instead of reusing
 * the cancelled one (DEC-106). `DOCUMENT_NUMBER_VOIDED` is registered in the event catalog
 * (Appendix C.8) but still has a null producer, aggregate, and payload schema, so no envelope
 * can be published for it yet; the audit entry is the record until `packages/contracts`
 * completes that catalog entry.
 */
export async function voidDocumentNumber(
  pool: Pool, rawInput: VoidNumberInput, transaction?: AuditedTransaction,
): Promise<DocumentNumber> {
  const parsed = VoidSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  const run = async (client: PoolClient, audit: AuditedTransaction['appendAuditEntry']) => {
    const { rows } = await client.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM platform.document_number_reservation
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.reservationId, input.organizationId],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status === 'VOID') {
      // A void is permanent, so a repeat is a replay of the same fact, not a second void.
      await audit({
        organizationId: input.organizationId,
        ...(row.branch_id ? { branchId: row.branch_id } : {}),
        actor: { ...(input.voidedBy ? { userId: input.voidedBy } : {}), serviceIdentity: 'platform.documents', roles: [] },
        action: 'DOCUMENT_NUMBER_VOIDED',
        entity: { domain: 'platform', type: 'NumberReservation', id: input.reservationId, version: row.version },
        changes: [{ path: 'replay', classification: 'INTERNAL', after: row.status }],
        requestId: input.requestId, correlationId: input.requestId, source: 'SYSTEM',
      });
      return toDocumentNumber(row);
    }
    if (row.status !== 'RESERVED') throw new DomainError('INVALID_STATE_TRANSITION');
    const version = row.version + 1;
    const updated = await client.query<ReservationRow>(
      `UPDATE platform.document_number_reservation
       SET status = 'VOID', void_reason = $2, voided_by = $3, voided_at = now(),
           version = $4, updated_at = now()
       WHERE id = $1 RETURNING ${RESERVATION_COLUMNS}`,
      [input.reservationId, input.reason, input.voidedBy ?? null, version],
    );
    const voided = updated.rows[0];
    if (!voided) throw new Error('The reservation was not returned after voiding.');
    await audit({
      organizationId: input.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id } : {}),
      actor: { ...(input.voidedBy ? { userId: input.voidedBy } : {}), serviceIdentity: 'platform.documents', roles: [] },
      action: 'DOCUMENT_NUMBER_VOIDED',
      entity: { domain: 'platform', type: 'NumberReservation', id: input.reservationId, version },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: row.status, after: 'VOID' },
        { path: 'voidReason', classification: 'INTERNAL', after: input.reason },
      ],
      reasonCode: input.reason,
      requestId: input.requestId, correlationId: input.requestId, source: 'SYSTEM',
    });
    return toDocumentNumber(voided);
  };
  return withConnection(pool, transaction?.client, ({ client, appendAuditEntry }) => run(client, appendAuditEntry));
}

export interface NumberingSchemeView {
  id: string;
  organizationId: string;
  branchId: string | null;
  docType: string;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  pattern: string | null;
  branchCode: string | null;
  resetPolicy: 'YEARLY' | 'MONTHLY' | 'NEVER' | null;
  gapPolicy: 'NO_GAP_FISCAL' | 'GAP_ALLOWED' | null;
  padding: number | null;
  startAt: string;
  validFrom: string;
  validTo: string | null;
  version: number;
  /** True only when every field GAP-16 still owes us is present. */
  readyForActivation: boolean;
}

// `valid_from::text` and `valid_to::text` because node-postgres materialises a `date` as a
// JavaScript Date at local midnight, so toISOString() would shift the business date by the
// server's UTC offset (AGENTS.md §11 keeps the business date in Asia/Jakarta).
const SCHEME_COLUMNS = `id, organization_id, branch_id, doc_type, status, pattern, branch_code,
  reset_policy, gap_policy, padding, start_at::text AS start_at,
  valid_from::text AS valid_from, valid_to::text AS valid_to, version`;

function toSchemeView(row: Record<string, unknown>): NumberingSchemeView {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    branchId: (row.branch_id as string | null) ?? null,
    docType: row.doc_type as string,
    status: row.status as NumberingSchemeView['status'],
    pattern: (row.pattern as string | null) ?? null,
    branchCode: (row.branch_code as string | null) ?? null,
    resetPolicy: (row.reset_policy as NumberingSchemeView['resetPolicy']) ?? null,
    gapPolicy: (row.gap_policy as NumberingSchemeView['gapPolicy']) ?? null,
    padding: (row.padding as number | null) ?? null,
    startAt: row.start_at as string,
    validFrom: row.valid_from as string,
    validTo: (row.valid_to as string | null) ?? null,
    version: row.version as number,
    readyForActivation: row.pattern !== null && row.branch_code !== null
      && row.reset_policy !== null && row.gap_policy !== null && row.padding !== null,
  };
}

/**
 * Creates a numbering scheme. `status` is the caller's because activating a scheme is
 * Finance/Tax's decision under GAP-16, not Platform's: an ACTIVE scheme may only be created
 * for a type whose approved pattern the operator already holds, and an incomplete one is
 * refused so `reserveDocumentNumber` never has to guess a missing field.
 */
export async function createNumberingScheme(
  pool: Pool, rawInput: CreateSchemeInput, transaction?: AuditedTransaction,
): Promise<NumberingSchemeView> {
  const parsed = CreateSchemeSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  const { status } = input;
  if (status === 'ACTIVE' && (input.pattern === undefined || input.branchCode === undefined
    || input.resetPolicy === undefined || input.gapPolicy === undefined || input.padding === undefined)) {
    throw new DomainError('INVALID_STATE_TRANSITION');
  }
  return withConnection(pool, transaction?.client, async ({ client, appendAuditEntry }) => {
    const id = randomUUID();
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO platform.document_numbering_scheme (
         id, organization_id, branch_id, doc_type, status, pattern, branch_code,
         reset_policy, gap_policy, padding, start_at, valid_from, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12::date,$13)
       ON CONFLICT (organization_id,
                      coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      doc_type, valid_from)
       DO UPDATE SET updated_at = now()
       RETURNING ${SCHEME_COLUMNS}`,
      [id, input.organizationId, input.branchId ?? null, input.docType, status,
        input.pattern ?? null, input.branchCode ?? null, input.resetPolicy ?? null,
        input.gapPolicy ?? null, input.padding ?? null, input.startAt, input.validFrom, id],
    );
    const row = rows[0];
    if (!row) throw new Error('The numbering scheme was not returned after insertion.');
    await appendAuditEntry({
      organizationId: input.organizationId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      actor: { serviceIdentity: 'platform.documents', roles: [] },
      action: 'NUMBERING_SCHEME_CREATED',
      entity: { domain: 'platform', type: 'NumberingScheme', id: row.id as string, version: 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', after: status },
        { path: 'docType', classification: 'INTERNAL', after: input.docType },
        // GAP-16: unapproved fields are recorded as UNSET so the trail is honest about what
        // is decided and what is still waiting on Finance/Tax.
        { path: 'pattern', classification: 'INTERNAL', after: input.pattern ?? 'UNSET' },
        { path: 'branchCode', classification: 'INTERNAL', after: input.branchCode ?? 'UNSET' },
        { path: 'gapPolicy', classification: 'INTERNAL', after: input.gapPolicy ?? 'UNSET' },
      ],
      requestId: input.requestId, correlationId: input.requestId, source: 'API',
    });
    return toSchemeView(row);
  });
}

/**
 * DOC-001.R04 seed: the S3 document types exist as DRAFT schemes with every unapproved field
 * left NULL, so Finance/Ops have something concrete to review under GAP-16. A seeded pattern,
 * branch code, or gap policy would be a guess presented as a decision, so none is written.
 */
const S3_DOCUMENT_TYPES = [
  'SO', 'DO', 'SJ', 'INV', 'CN', 'PAY', 'TGH', 'STK', 'PO', 'GR',
  'SI', 'SPAY', 'TRF', 'ADJ', 'RET', 'JV', 'KK', 'WO',
] as const;

export async function seedDraftNumberingSchemes(
  pool: Pool, rawInput: SeedDraftSchemesInput, transaction?: AuditedTransaction,
): Promise<{ created: number; schemes: NumberingSchemeView[] }> {
  const parsed = SeedDraftsSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  const existing = await listNumberingSchemes(pool, input.organizationId, input.branchId);
  const known = new Set(existing.map((scheme) => scheme.docType));
  const missing = S3_DOCUMENT_TYPES.filter((docType) => !known.has(docType));
  const validFrom = input.validFrom ?? jakartaBusinessDate();
  const schemes: NumberingSchemeView[] = [];
  // One transaction for the whole seed: either every registered document type lands or none does.
  for (const docType of missing) {
    schemes.push(await createNumberingScheme(pool, {
      organizationId: input.organizationId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      docType, validFrom, requestId: `${input.requestId}:${docType}`,
    }, transaction));
  }
  if (schemes.length === 0 && !transaction) {
    // A re-seed with a fresh idempotency key finds every type already present. That is a
    // successful no-op, not a failure, so the audit guard must not reject it — but "an operator
    // asked to seed and everything was already there" is worth recording, so it is traced
    // rather than passed through silently. See ADR-0013.
    return withConnection(pool, undefined, async ({ appendAuditEntry }) => {
      await appendAuditEntry({
        organizationId: input.organizationId,
        ...(input.branchId ? { branchId: input.branchId } : {}),
        actor: { serviceIdentity: 'platform.documents', roles: [] },
        action: 'NUMBERING_SCHEMES_SEED_NOOP',
        entity: { domain: 'platform', type: 'NumberingScheme', id: input.organizationId, version: 1 },
        changes: [{ path: 'created', classification: 'INTERNAL', before: S3_DOCUMENT_TYPES.length, after: 0 }],
        requestId: input.requestId, correlationId: input.requestId, source: 'API',
      });
      return { created: 0, schemes: existing };
    });
  }
  if (schemes.length === 0) {
    // A caller-supplied transaction that produced nothing still needs a trail, for the same reason.
    await transaction!.appendAuditEntry({
      organizationId: input.organizationId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      actor: { serviceIdentity: 'platform.documents', roles: [] },
      action: 'NUMBERING_SCHEMES_SEED_NOOP',
      entity: { domain: 'platform', type: 'NumberingScheme', id: input.organizationId, version: 1 },
      changes: [{ path: 'created', classification: 'INTERNAL', before: S3_DOCUMENT_TYPES.length, after: 0 }],
      requestId: input.requestId, correlationId: input.requestId, source: 'API',
    });
  }
  return { created: schemes.length, schemes: schemes.length > 0 ? schemes : existing };
}

export async function listNumberingSchemes(
  pool: Pool, organizationId: string, branchId?: string,
): Promise<NumberingSchemeView[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT ${SCHEME_COLUMNS} FROM platform.document_numbering_scheme
     WHERE organization_id = $1
       AND coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) =
           coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY doc_type, valid_from DESC`,
    [organizationId, branchId ?? null],
  );
  return rows.map(toSchemeView);
}

export interface SequenceUsage {
  docType: string;
  periodKey: string;
  used: number;
  reserved: number;
  voided: number;
  lastValue: string;
}

/** DOC-001.R03 / AC06: every ordinal in a period, so a gap is either absent or explained by a VOID. */
export async function numberSequenceUsage(
  pool: Pool, organizationId: string, docType: string, branchId?: string,
): Promise<SequenceUsage[]> {
  const { rows } = await pool.query<{
    doc_type: string; period_key: string; used: string; reserved: string; voided: string; last_value: string;
  }>(
    `SELECT r.doc_type, r.period_key,
            count(*) FILTER (WHERE r.status = 'CONFIRMED')::bigint AS used,
            count(*) FILTER (WHERE r.status = 'RESERVED')::bigint AS reserved,
            count(*) FILTER (WHERE r.status = 'VOID')::bigint AS voided,
            max(r.sequence_value)::bigint AS last_value
     FROM platform.document_number_reservation r
     WHERE r.organization_id = $1
       AND coalesce(r.branch_id, '00000000-0000-0000-0000-000000000000'::uuid) =
           coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND r.doc_type = $2
     GROUP BY r.doc_type, r.period_key ORDER BY r.period_key`,
    [organizationId, docType, branchId ?? null],
  );
  return rows.map((row) => ({
    docType: row.doc_type,
    periodKey: row.period_key,
    used: Number(row.used),
    reserved: Number(row.reserved),
    voided: Number(row.voided),
    lastValue: row.last_value,
  }));
}
