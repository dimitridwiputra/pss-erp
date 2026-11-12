import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { parseCommandInput } from '../domain/rules/parse-command-input';

/** A product's default sales tax code, or null when master data records none. */
export type ProductTaxCode = 'VAT_OUTPUT' | 'EXEMPT' | 'NON_VAT' | null;

const GetProductTaxCodesInputSchema = z.strictObject({
  productIds: z.array(z.uuid()).min(1).max(500),
  organizationId: z.uuid(),
});
export type GetProductTaxCodesInput = z.input<typeof GetProductTaxCodesInputSchema>;

const TAX_CODE_PATTERN = /^(VAT_OUTPUT|EXEMPT|NON_VAT)$/;

interface ProductRow {
  id: string;
  tax_code: string | null;
}

/**
 * The default tax code of each requested product, keyed by product id.
 *
 * A batch read rather than one per line: an invoice is prepared inside a checkout transaction that
 * already holds a pool client, and a query per line would be a query per basket row. Products that
 * do not exist are simply absent from the result — the caller treats a missing entry and a stored
 * NULL identically, because both mean "this product has no tax code", and the column's CHECK keeps
 * any stored value inside the vocabulary.
 */
export async function getProductTaxCodes(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: GetProductTaxCodesInput,
): Promise<Map<string, ProductTaxCode>> {
  const input = parseCommandInput(GetProductTaxCodesInputSchema, rawInput);
  const executor = client ?? pool;
  const result = await executor.query<ProductRow>(
    `SELECT id, tax_code FROM core.product
     WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [input.organizationId, input.productIds],
  );
  return new Map(result.rows.map((row) => {
    if (row.tax_code !== null && !TAX_CODE_PATTERN.test(row.tax_code)) {
      throw new DomainError('TAX_CODE_MISSING', ['Lengkapi Produk'], [{
        path: `products.${row.id}.taxCode`, code: 'unsupported_value',
        message: 'Kode pajak produk belum dikonfigurasi.',
      }]);
    }
    return [row.id, (row.tax_code ?? null) as ProductTaxCode];
  }));
}