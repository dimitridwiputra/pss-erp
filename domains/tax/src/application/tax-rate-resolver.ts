import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { getConfig, type ConfigValueRow } from '@pss/configuration';
import { loadConfigRows } from '@pss/platform';
import {
  ApplicableTaxRateSchema, TaxCodeRecordSchema,
  type ApplicableTaxRate, type TaxCodeRecord,
} from '../domain/tax-code';
import { ROUNDING_RULE_CONFIG_KEY } from '../domain/rules/resolve-sales-tax';

/**
 * The scope and date a configuration lookup is made for.
 *
 * A type rather than a schema because these functions are not a command boundary: they are called
 * from inside a command that has already validated its own input, and re-validating here would give
 * the caller two places where a bad `organizationId` fails.
 */
export interface LoadTaxContextInput {
  organizationId: string;
  /**
   * Branch scope, so a rounding rule may be narrowed to a branch by PLT-009.BR02. Written as
   * `string | undefined` rather than `?:` because the workspace compiles with
   * `exactOptionalPropertyTypes`, and a caller that holds an optional `branchId` must be able to
   * pass it straight through instead of conditionally rebuilding the object.
   */
  branchId: string | undefined;
  businessDate: string;
}

export interface TaxResolutionContext {
  /** The rate rows in force on the business date, as `resolveSalesTax` consumes them. */
  taxRates: ApplicableTaxRate[];
  taxCodes: TaxCodeRecord[];
  /** The raw `tax.rounding_rule` value; the resolver decides whether it is acceptable. */
  roundingRule: unknown;
}

/**
 * `tax_rate.valid_from` and `valid_to` are cast to text in SQL on purpose. node-postgres
 * materialises a `date` as a JavaScript Date at local midnight, so `toISOString()` shifts it by the
 * server's UTC offset and a rate effective on 1 November would read as 31 October — which would
 * silently apply the wrong rate to a business date (TAX-001.AC01).
 */
const RATE_ROW_SCHEMA = z.object({
  code: ApplicableTaxRateSchema.shape.taxCode,
  rate: ApplicableTaxRateSchema.shape.rate,
  valid_from: z.iso.date(),
  valid_to: z.iso.date().nullable(),
  rate_id: z.uuid(),
});

/**
 * The rate rows an organization has applicable on a business date (TAX-001.BR01).
 *
 * Only ACTIVE rows are returned, so a rate still awaiting its approval decision cannot be applied
 * (TAX-001.NC02). The code's own `active` flag is filtered too: retiring a code has to stop it
 * resolving without deleting the rates that were computed under it.
 */
export async function loadApplicableTaxRates(
  client: Pool | PoolClient,
  organizationId: string,
  businessDate: string,
): Promise<ApplicableTaxRate[]> {
  const { rows } = await client.query(
    `SELECT c.code, r.rate::text AS rate, r.valid_from::text AS valid_from,
            r.valid_to::text AS valid_to, r.id AS rate_id
     FROM core.tax_rate r
     JOIN core.tax_code c ON c.id = r.tax_code_id
     WHERE r.organization_id = $1::uuid
       AND c.active
       AND r.status = 'ACTIVE'
       AND r.valid_from <= $2::date
       AND (r.valid_to IS NULL OR r.valid_to > $2::date)
     ORDER BY c.code, r.valid_from DESC`,
    [organizationId, businessDate],
  );
  return z.array(RATE_ROW_SCHEMA).parse(rows).map((row) => ({
    taxCode: row.code,
    rate: row.rate,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    rateId: row.rate_id,
  }));
}

/**
 * The whole tax-code vocabulary, including codes with no applicable rate.
 *
 * `resolveSalesTax` needs `zero_rated` for every code it might apply — including a zero-rated code,
 * which is precisely the case with no rate row and therefore absent from the query above.
 */
export async function loadTaxCodes(client: Pool | PoolClient): Promise<TaxCodeRecord[]> {
  const { rows } = await client.query(
    `SELECT id, code, name, zero_rated AS "zeroRated", active
     FROM core.tax_code ORDER BY code`,
  );
  return z.array(TaxCodeRecordSchema).parse(rows);
}

/**
 * Narrows a value out of a `jsonb` column to the JSON shape the configuration library ranks, or
 * null when it is not JSON at all. Null is deliberately the failure: a row whose value cannot be
 * ranked must be UNSET to the reader, so the caller blocks, because treating it as present would
 * hand the library something it cannot compare and let it pick a winner by accident.
 */
function asJsonValue(value: unknown): ConfigValueRow['value'] {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The configuration value in force for a key at a business date, or null when it is KOSONG.
 *
 * The row query is `@pss/platform`'s and the effective-dating and scope ranking are
 * `@pss/configuration`'s (PLT-009.BR02/BR04/AC02): both problems already have exactly one
 * implementation, and re-deriving either here is how a second, subtly different resolver appears.
 */
export async function loadConfigValueInForce(
  pool: Pool,
  key: string,
  input: LoadTaxContextInput,
): Promise<unknown> {
  const platformRows = await loadConfigRows(pool, {
    key,
    organizationId: input.organizationId,
    scope: input.branchId ? { branchId: input.branchId } : {},
  });
  // `@pss/platform` types a row's `value` as `unknown` because it comes out of `jsonb`, while
  // `@pss/configuration` takes `JsonValue` because it ranks and compares it. The column is `jsonb`,
  // so the value IS JSON — this re-validates that fact at the boundary instead of casting, because a
  // cast would let a non-JSON value reach the library's ranking as if it were sound. A value that
  // fails is UNSET to the caller, which blocks rather than guesses.
  const rows: ConfigValueRow[] = platformRows.map((row) => ({
    key: row.key,
    scope: row.scope,
    value: asJsonValue(row.value),
    validFrom: row.validFrom,
    ...(row.validTo === undefined ? {} : { validTo: row.validTo }),
    status: row.status,
    ...(row.revision === undefined ? {} : { revision: row.revision }),
  }));
  const result = getConfig(rows, key, {
    organizationId: input.organizationId,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    businessDate: input.businessDate,
  });
  // KOSONG and "no row at all" both come back as UNSET, and PLT-009.AC02 requires that neither be
  // replaced by a default. The caller decides what an UNSET key means.
  return result.kind === 'VALUE' ? result.value : null;
}

/**
 * The raw `tax.rounding_rule` value in force. Deliberately unparsed: whether an unset or
 * unrecognised value blocks is the resolver's decision (TAX-000.R03), not a read-path concern.
 */
export function loadRoundingRule(pool: Pool, input: LoadTaxContextInput): Promise<unknown> {
  return loadConfigValueInForce(pool, ROUNDING_RULE_CONFIG_KEY, input);
}

/**
 * Everything `resolveSalesTax` needs for a document, loaded once rather than per line.
 *
 * The rate and code reads share the caller's transaction, so a rate activated in the same
 * transaction is visible and a rate that changed mid-document cannot produce two different answers
 * across the lines of one invoice. The configuration read cannot join it: `@pss/platform`'s
 * `loadConfigRows` takes a pool, and a rounding rule that moved between the read and the commit
 * would not produce an inconsistent invoice anyway — it is snapshotted onto the lines, which is
 * what makes the issued invoice independent of it afterwards (TAX-002.BR03).
 *
 * `readRoundingRule` is a parameter rather than unconditional because a document whose every line is
 * zero-rated has no amount to round. Reading the key anyway would make an exempt invoice depend on
 * `platform.config_value` existing, which is exactly the coupling TAX-000.R03's KOSONG-is-blocking
 * rule is about: blocking must apply to the document that actually needs the value.
 */
export async function loadTaxResolutionContext(
  pool: Pool,
  client: PoolClient,
  input: LoadTaxContextInput,
  options: { readRoundingRule: boolean },
): Promise<TaxResolutionContext> {
  const [taxRates, taxCodes, roundingRule] = await Promise.all([
    loadApplicableTaxRates(client, input.organizationId, input.businessDate),
    loadTaxCodes(client),
    // A skipped read is reported as null, which is what a zero-rated-only document expects; the
    // resolver never asks for the rule on such a line.
    options.readRoundingRule ? loadRoundingRule(pool, input) : Promise.resolve(null),
  ]);
  return { taxRates, taxCodes, roundingRule };
}