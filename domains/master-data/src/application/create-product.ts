import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { isUniqueViolation } from '../domain/rules/is-unique-violation';
import { parseCommandInput } from '../domain/rules/parse-command-input';

/** `core.product.status` — a new product starts DRAFT so it cannot be sold before it is priced. */
export const ProductStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']);

const CreateProductInputSchema = z.strictObject({
  organizationId: z.uuid(),
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  /** The product's own unit. Its `core.product_uom` row is created with this command, factor 1. */
  baseUom: z.string().trim().min(1).max(16),
  orderCapture: z.enum(['PSS', 'EXTERNAL']).optional(),
  status: ProductStatusSchema.optional(),
  ...OptionalAuditContextSchema.shape,
});

export type CreateProductInput = z.input<typeof CreateProductInputSchema>;

export interface CreatedProduct {
  productId: string;
  organizationId: string;
  sku: string;
  name: string;
  baseUom: string;
  orderCapture: 'PSS' | 'EXTERNAL';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  version: number;
}

/**
 * MDM-001/002: creates the product and its base unit in one audited transaction.
 *
 * The `core.product_uom` row is part of the same command rather than a follow-up call because
 * `conversion_factor` is `NOT NULL` and a product whose base unit does not exist cannot be
 * received, priced, or scanned — every one of those paths resolves a UoM. A caller that wants a
 * case unit adds it with `addProductUom`.
 *
 * The product starts `DRAFT` unless a status is given, because POS only sells `ACTIVE` products
 * (`PosService.scan` checks `status === 'ACTIVE'`) and a product with no price and no stock is not
 * sellable. That is a default, not a rule: passing `status` overrides it.
 *
 * A duplicate SKU inside one organization is `DUPLICATE_CODE`; the same SKU in another organization
 * is a different product and is allowed by `UNIQUE (organization_id, sku)`.
 */
export async function createProduct(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: CreateProductInput,
): Promise<CreatedProduct> {
  const input = parseCommandInput(CreateProductInputSchema, rawInput);
  const orderCapture = input.orderCapture ?? 'PSS';
  const status = input.status ?? 'DRAFT';

  const work = async (transaction: AuditedTransaction): Promise<CreatedProduct> => {
    const tx = transaction.client;
    const productId = randomUUID();
    try {
      await tx.query(
        `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [productId, input.organizationId, input.sku, input.name, input.baseUom, orderCapture, status],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new DomainError('DUPLICATE_CODE', ['Ubah Kode'], [{
        path: 'sku', code: 'duplicate', message: `Kode barang ${input.sku} sudah dipakai.`,
      }]);
    }
    await tx.query(
      `INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base)
       VALUES ($1, $2, $3, 1, true)`,
      [randomUUID(), productId, input.baseUom],
    );

    const auditContext = resolveAuditContext(input, productId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRODUCT_CREATED',
      entity: { domain: 'master-data', type: 'Product', id: productId, version: 1 },
      changes: [
        { path: 'sku', classification: 'INTERNAL', after: input.sku },
        { path: 'name', classification: 'INTERNAL', after: input.name },
        { path: 'baseUom', classification: 'INTERNAL', after: input.baseUom },
        { path: 'orderCapture', classification: 'INTERNAL', after: orderCapture },
        { path: 'status', classification: 'INTERNAL', after: status },
      ],
      requestId: auditContext.requestId,
      correlationId: auditContext.correlationId,
      source: auditContext.source,
    });

    return { productId, organizationId: input.organizationId, sku: input.sku, name: input.name, baseUom: input.baseUom, orderCapture, status, version: 1 };
  };

  return withConnection(pool, client, work);
}
