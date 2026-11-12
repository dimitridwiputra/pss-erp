import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { isUniqueViolation } from '../domain/rules/is-unique-violation';
import { parseCommandInput } from '../domain/rules/parse-command-input';

/**
 * A barcode is an opaque label, not a number this module understands. AGENTS.md §6 forbids writing a
 * barcode standard, so no check digit and no symbology is verified here — only that the string is
 * something a scanner could read. A code that fails this shape is `INVALID_BARCODE` (Appendix F);
 * a code that is well formed but already taken is `DUPLICATE_CODE` with the field message below,
 * because Appendix F has no dedicated duplicate-barcode code (MVP-OD-17).
 */
export const BarcodeSchema = z
  .string()
  .trim()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'A barcode contains letters, digits, dot, dash or underscore.');

const AddProductBarcodeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  productId: z.uuid(),
  barcode: BarcodeSchema,
  /** Which unit of the product this label represents — a case barcode is not a piece barcode. */
  uom: z.string().trim().min(1).max(16),
  ...OptionalAuditContextSchema.shape,
});

export type AddProductBarcodeInput = z.input<typeof AddProductBarcodeInputSchema>;

export interface ProductBarcodeAdded {
  barcodeId: string;
  productId: string;
  barcode: string;
  uom: string;
}

/**
 * MDM-003: attaches a barcode to a product and to one of that product's units.
 *
 * The unit must already exist on the product, because a barcode identifies exactly one product *and*
 * one UoM of it (this domain's invariant): `findProductByBarcode` hands the pair to POS, which then
 * prices and reserves in that unit. A label pointing at a unit the product does not sell would make
 * a scan succeed and the sale fail later, which is worse than refusing it here.
 *
 * A barcode already attached to any product is refused. `core.product_barcode.barcode` is unique
 * globally, which is stronger than the per-organization rule the MVP states and is also what an
 * EAN/UPC requires — the same digits cannot mean two products in two organizations of one business.
 * Adding a per-organization duplicate would be a destructive index change, so it is not done here.
 */
export async function addProductBarcode(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: AddProductBarcodeInput,
): Promise<ProductBarcodeAdded> {
  const input = parseCommandInput(AddProductBarcodeInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<ProductBarcodeAdded> => {
    const tx = transaction.client;
    const product = await tx.query<{ id: string }>(
      'SELECT id FROM core.product WHERE id = $1 AND organization_id = $2',
      [input.productId, input.organizationId],
    );
    if (!product.rows[0]) throw new DomainError('NOT_FOUND');

    const unit = await tx.query(
      'SELECT 1 FROM core.product_uom WHERE product_id = $1 AND uom = $2',
      [input.productId, input.uom],
    );
    if (!unit.rows[0]) {
      throw new DomainError('VALIDATION_FAILED', [], [{
        path: 'uom', code: 'unknown_uom',
        message: `Satuan ${input.uom} belum ada pada barang ini. Tambahkan satuannya lebih dulu.`,
      }]);
    }

    const barcodeId = randomUUID();
    try {
      await tx.query(
        'INSERT INTO core.product_barcode (id, product_id, uom, barcode) VALUES ($1, $2, $3, $4)',
        [barcodeId, input.productId, input.uom, input.barcode],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new DomainError('DUPLICATE_CODE', ['Periksa Barcode'], [{
        path: 'barcode', code: 'duplicate',
        message: `Barcode ${input.barcode} sudah dipakai barang lain. Gunakan barcode yang lain.`,
      }]);
    }

    const auditContext = resolveAuditContext(input, input.productId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRODUCT_BARCODE_ADDED',
      entity: { domain: 'master-data', type: 'ProductBarcode', id: barcodeId, version: 1 },
      changes: [
        { path: 'barcode', classification: 'INTERNAL', after: input.barcode },
        { path: 'uom', classification: 'INTERNAL', after: input.uom },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { barcodeId, productId: input.productId, barcode: input.barcode, uom: input.uom };
  };

  return withConnection(pool, client, work);
}
