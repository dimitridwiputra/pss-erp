import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * The schema set an invoicing tax test needs, applied to a fresh test database.
 *
 * `applyMigrations` replays a domain's ordered list from the directory rather than from a hardcoded
 * file name, so a new migration is picked up here without editing this file. A fixture that replayed
 * only `0001` is what made amending a shipped migration look safe (MIG-RISK-AUD-001), and the
 * snapshot columns these tests assert on arrive in invoicing's `0002`.
 *
 * The dependency set is the four others a tax-resolved invoice reads: audit (every command audits),
 * platform (`platform.config_value` for `tax.rounding_rule` and `tax.vat_output_rate`), master-data
 * (the customer and product rows the tax codes are read from), and tax (`core.tax_code` /
 * `core.tax_rate`).
 */
export async function applyInvoiceSchemas(executor: pg.Pool): Promise<void> {
  const { applyAuditMigrations, applyMigrations } = await import('../../../scripts/apply-migrations.mjs');
  await applyAuditMigrations(executor);
  await applyMigrations(executor, 'platform');
  await applyMigrations(executor, 'master-data');
  await applyMigrations(executor, 'tax');
  await applyMigrations(executor, 'invoicing');
}

/** Creates a throwaway database and returns a pool pointed at it. */
export async function createTestDatabase(prefix: string): Promise<{
  pool: pg.Pool;
  drop: () => Promise<void>;
}> {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  const databaseName = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    },
  };
}

export type SalesTaxCode = 'VAT_OUTPUT' | 'EXEMPT' | 'NON_VAT';

/**
 * A customer with a recorded tax treatment.
 *
 * Written as a fixture insert rather than through `createCustomer` so a tax test's setup is one row
 * and the customer's own audit trail stays the subject of master-data's tests. `null` is available
 * because "created without a treatment" is a state the tax resolver has to refuse.
 */
export async function seedCustomer(
  pool: pg.Pool,
  input: { organizationId: string; taxTreatment: SalesTaxCode | null },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO core.customer (id, organization_id, code, name, status, tax_treatment)
     VALUES ($1, $2, $3, 'Toko Fixture', 'ACTIVE', $4)`,
    [id, input.organizationId, `CUS-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`, input.taxTreatment],
  );
  return id;
}

/** A product with a recorded default tax code, or with none when `taxCode` is null. */
export async function seedProduct(
  pool: pg.Pool,
  input: { organizationId: string; taxCode: SalesTaxCode | null },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO core.product (id, organization_id, sku, name, base_uom, status, tax_code)
     VALUES ($1, $2, $3, 'Produk Fixture', 'PCS', 'ACTIVE', $4)`,
    [id, input.organizationId, `SKU-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`, input.taxCode],
  );
  return id;
}

/**
 * Puts the two registered tax configuration keys in force for an organization.
 *
 * Written as a direct insert into `platform.config_value` rather than through `proposeConfigValue`
 * because that key is SENSITIVE, and `proposeConfigValue` requires an approval id for a SENSITIVE
 * key — a second approval setup inside a tax fixture would test PLT-009's write path, not tax
 * resolution. Both keys are inserted ACTIVE with a valid_from in the past so they are in force for
 * any business date the test chooses.
 *
 * `roundingRule: null` stores KOSONG explicitly, which is the state TAX-000.R03 says must block.
 */
export async function setTaxConfiguration(
  pool: pg.Pool,
  input: { organizationId: string; roundingRule: string | null; outputVatEnabled?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO platform.config_value (
       id, key, organization_id, value, valid_from, status, proposed_by, revision, reason_code
     ) VALUES ($1, 'tax.rounding_rule', $2, $3::jsonb, DATE '2020-01-01', 'ACTIVE', $4, 1, 'fixture'),
            ($5, 'tax.vat_output_rate', $2, $6::jsonb, DATE '2020-01-01', 'ACTIVE', $4, 1, 'fixture')`,
    [
      randomUUID(), input.organizationId,
      input.roundingRule === null ? null : JSON.stringify(input.roundingRule),
      randomUUID(), randomUUID(),
      input.outputVatEnabled === false ? null : JSON.stringify('ENABLED'),
    ],
  );
}

/**
 * A rate that is already in force: the row `scheduleTaxRate` would write, with approval resolved.
 *
 * Inserted ACTIVE directly because exercising the approval path is `applyApprovalDecision`'s own
 * test; a resolution fixture that had to run two approvals to obtain an 11% rate would be testing
 * the approval engine. The row is otherwise shaped exactly as the command writes it, including a
 * `valid_to` when the rate is superseded.
 */
export async function seedActiveTaxRate(
  pool: pg.Pool,
  input: {
    organizationId: string;
    rate: string;
    /**
     * The first day the rate applies. Defaults to a date before any test's business date, because
     * almost every fixture wants "always in force" and only the effective-dating test cares.
     */
    validFrom?: string;
    validTo?: string;
    taxCode?: 'VAT_OUTPUT' | 'VAT_INPUT';
  },
): Promise<string> {
  const code = await pool.query<{ id: string }>(
    `INSERT INTO core.tax_code (id, code, name, zero_rated)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [randomUUID(), input.taxCode ?? 'VAT_OUTPUT', input.taxCode === 'VAT_INPUT' ? 'PPN Masukan' : 'PPN Keluaran'],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO core.tax_rate (id, organization_id, tax_code_id, rate, valid_from, valid_to, status, approval_id)
     VALUES ($1, $2, $3, $4::numeric, $5::date, $6::date, 'ACTIVE', $7)`,
    [id, input.organizationId, code.rows[0]!.id, input.rate, input.validFrom ?? '2020-01-01',
      input.validTo ?? null, randomUUID()],
  );
  return id;
}

/**
 * Replaces an organization's rate from a date, the way `scheduleTaxRate` does: the predecessor's
 * range is closed and a new ACTIVE row starts. Not a raw UPDATE — the `tax_rate_no_rewrite` trigger
 * rejects rewriting a rate's value outright (TAX-001.BR02), which is the behaviour these tests need
 * to be able to work around legitimately rather than by disabling a constraint.
 */
export async function supersedeTaxRate(
  pool: pg.Pool,
  input: { organizationId: string; rate: string; validFrom: string; taxCode?: 'VAT_OUTPUT' | 'VAT_INPUT' },
): Promise<string> {
  const code = await pool.query<{ id: string }>(
    `SELECT id FROM core.tax_code WHERE code = $1`, [input.taxCode ?? 'VAT_OUTPUT'],
  );
  const taxCodeId = code.rows[0]?.id;
  if (!taxCodeId) throw new Error('The tax code must be seeded before its rate is superseded.');
  await pool.query(
    `UPDATE core.tax_rate SET valid_to = $3::date
     WHERE organization_id = $1::uuid AND tax_code_id = $2::uuid AND valid_from < $3::date`,
    [input.organizationId, taxCodeId, input.validFrom],
  );
  return seedActiveTaxRate(pool, { ...input, validFrom: input.validFrom });
}

/** The EXEMPT and NON_VAT vocabulary rows, which carry no rate and must still resolve. */
export async function seedZeroRatedTaxCodes(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO core.tax_code (id, code, name, zero_rated)
     VALUES ($1, 'EXEMPT', 'Bebas PPN', true), ($2, 'NON_VAT', 'Tidak Kena PPN', true)
     ON CONFLICT (code) DO UPDATE SET zero_rated = EXCLUDED.zero_rated`,
    [randomUUID(), randomUUID()],
  );
}

/** A product and customer pair plus their tax codes, for one sales document. */
export async function seedSaleParty(
  pool: pg.Pool,
  input: { organizationId: string; customerTaxTreatment: SalesTaxCode | null; productTaxCode: SalesTaxCode | null },
): Promise<{ customerId: string; productId: string }> {
  return {
    customerId: await seedCustomer(pool, {
      organizationId: input.organizationId, taxTreatment: input.customerTaxTreatment,
    }),
    productId: await seedProduct(pool, {
      organizationId: input.organizationId, taxCode: input.productTaxCode,
    }),
  };
}