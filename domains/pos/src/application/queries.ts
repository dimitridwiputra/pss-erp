import type { Pool } from 'pg';

export interface PosSaleLineRow { id: string; productId: string; sku: string; name: string; uom: string; qty: string; unitPrice: string; lineTotal: string }
export interface PosSaleRow {
  id: string; number: string | null; status: string; customerId: string | null;
  subtotal: string; taxTotal: string; total: string; invoiceNumber: string | null;
}

export async function getPosSale(pool: Pool, saleId: string): Promise<(PosSaleRow & { lines: PosSaleLineRow[] }) | null> {
  const sale = await pool.query<{
    id: string; number: string | null; status: string; customer_id: string | null;
    subtotal: string; tax_total: string; total: string; invoice_number: string | null;
  }>('SELECT id, number, status, customer_id, subtotal, tax_total, total, invoice_number FROM pos.pos_sale WHERE id = $1', [saleId]);
  const row = sale.rows[0];
  if (!row) return null;
  const lines = await pool.query<{ id: string; product_id: string; sku: string; name: string; uom: string; qty: string; unit_price: string; line_total: string }>(
    'SELECT id, product_id, sku, name, uom, qty, unit_price, line_total FROM pos.pos_sale_line WHERE sale_id = $1 ORDER BY created_at', [saleId],
  );
  return {
    id: row.id, number: row.number, status: row.status, customerId: row.customer_id,
    subtotal: row.subtotal, taxTotal: row.tax_total, total: row.total, invoiceNumber: row.invoice_number,
    lines: lines.rows.map((line) => ({
      id: line.id, productId: line.product_id, sku: line.sku, name: line.name, uom: line.uom,
      qty: line.qty, unitPrice: line.unit_price, lineTotal: line.line_total,
    })),
  };
}

export interface ShiftSaya {
  shift: { id: string; terminalId: string; status: string; openingFloat: string; expectedCash: string | null; countedCash: string | null; variance: string | null } | null;
  openSales: Array<PosSaleRow & { lines: PosSaleLineRow[] }>;
}

/** GET /kasir/shift-saya: the cashier's own open shift (POS-000.R08: at most one) plus any sale still awaiting payment. */
export async function getShiftSaya(pool: Pool, cashierUserId: string): Promise<ShiftSaya> {
  const shift = await pool.query<{
    id: string; terminal_id: string; status: string; opening_float: string;
    expected_cash: string | null; counted_cash: string | null; variance: string | null;
  }>("SELECT id, terminal_id, status, opening_float, expected_cash, counted_cash, variance FROM pos.pos_shift WHERE cashier_user_id = $1 AND status = 'OPEN'", [cashierUserId]);
  const shiftRow = shift.rows[0];
  if (!shiftRow) return { shift: null, openSales: [] };

  const openSaleIds = await pool.query<{ id: string }>(
    "SELECT id FROM pos.pos_sale WHERE shift_id = $1 AND status IN ('CART', 'PENDING_PAYMENT') ORDER BY created_at", [shiftRow.id],
  );
  const openSales = (await Promise.all(openSaleIds.rows.map((row) => getPosSale(pool, row.id)))).filter((sale): sale is PosSaleRow & { lines: PosSaleLineRow[] } => sale !== null);

  return {
    shift: {
      id: shiftRow.id, terminalId: shiftRow.terminal_id, status: shiftRow.status, openingFloat: shiftRow.opening_float,
      expectedCash: shiftRow.expected_cash, countedCash: shiftRow.counted_cash, variance: shiftRow.variance,
    },
    openSales,
  };
}
