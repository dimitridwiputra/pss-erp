import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { isUniqueViolation } from '../domain/rules/is-unique-violation';
import { parseCommandInput } from '../domain/rules/parse-command-input';

/**
 * A conversion factor is a decimal string, never a number: `core.product_uom.conversion_factor` is
 * `numeric(18,6)` and a pack size of 12.5 must not pass through a JS float (AGENTS.md §11.1).
 *
 * Zero and negative factors are refused by `requirePositiveFactor` rather than by the schema, so the
 * caller gets a field-level message naming the field instead of the column's CHECK violation
 * arriving as "Terjadi kendala". The column keeps enforcing it either way.
 */
const ConversionFactorSchema = DecimalStringSchema;

function requirePositiveFactor(conversionFactor: string): void {
  if (new Decimal(conversionFactor).lte(0)) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path: 'conversionFactor', code: 'not_positive', message: 'Isi satuannya harus lebih besar dari nol.',
    }]);
  }
}

const AddProductUomInputSchema = z.strictObject({
  organizationId: z.uuid(),
  productId: z.uuid(),
  uom: z.string().trim().min(1).max(16),
  /** How many of the product's base unit one of this unit holds, e.g. 40 for a KARTON of PCS. */
  conversionFactor: ConversionFactorSchema,
  ...OptionalAuditContextSchema.shape,
});

export type AddProductUomInput = z.input<typeof AddProductUomInputSchema>;

export interface ProductUomAdded {
  uomId: string;
  productId: string;
  uom: string;
  conversionFactor: string;
}

/**
 * MDM-003: adds a selling unit to a product, e.g. KARTON alongside PCS.
 *
 * The factor is written once and never edited. `UOM_FACTOR_LOCKED` ("Satuan sudah dipakai — buat
 * satuan baru bila isi karton berubah") says so in Appendix F, and it is the only safe answer for
 * this schema: stock, prices and historical movements all reference the unit, so changing the factor
 * afterwards would silently reinterpret every one of them. Adding a new unit instead is what the
 * error message tells the operator to do, and it is what this domain supports.
 */
export async function addProductUom(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: AddProductUomInput,
): Promise<ProductUomAdded> {
  const input = parseCommandInput(AddProductUomInputSchema, rawInput);
  requirePositiveFactor(input.conversionFactor);

  const work = async (transaction: AuditedTransaction): Promise<ProductUomAdded> => {
    const tx = transaction.client;
    const product = await tx.query<{ id: string }>(
      'SELECT id FROM core.product WHERE id = $1 AND organization_id = $2',
      [input.productId, input.organizationId],
    );
    if (!product.rows[0]) throw new DomainError('NOT_FOUND');

    const uomId = randomUUID();
    try {
      await tx.query(
        `INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base)
         VALUES ($1, $2, $3, $4::numeric, false)`,
        [uomId, input.productId, input.uom, input.conversionFactor],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new DomainError('DUPLICATE_CODE', ['Periksa Satuan'], [{
        path: 'uom', code: 'duplicate',
        message: `Satuan ${input.uom} sudah ada pada barang ini.`,
      }]);
    }

    const auditContext = resolveAuditContext(input, input.productId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRODUCT_UOM_ADDED',
      entity: { domain: 'master-data', type: 'ProductUom', id: uomId, version: 1 },
      changes: [
        { path: 'uom', classification: 'INTERNAL', after: input.uom },
        { path: 'conversionFactor', classification: 'INTERNAL', after: input.conversionFactor },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    const stored = await tx.query<{ conversion_factor: string }>(
      'SELECT conversion_factor FROM core.product_uom WHERE id = $1', [uomId],
    );
    return { uomId, productId: input.productId, uom: input.uom, conversionFactor: stored.rows[0]!.conversion_factor };
  };

  return withConnection(pool, client, work);
}
