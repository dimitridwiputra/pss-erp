import type { Pool } from 'pg';

/** A pool or an open transaction's client; reads accept either. */
export type Queryable = Pick<Pool, 'query'>;

/**
 * Canonical ownership of each POS aggregate, for authorization at the API boundary. A caller
 * supplies only an id; the organization, branch, warehouse and cashier always come from here,
 * never from the request (RBAC-002, NEXT_IMPLEMENTATION_PLAN §2).
 */
export interface PosTerminalScope {
  id: string; organizationId: string; branchId: string; warehouseId: string; code: string; name: string; status: 'ACTIVE' | 'INACTIVE';
}
export interface PosShiftScope {
  id: string; organizationId: string; branchId: string; warehouseId: string; terminalId: string; cashierUserId: string;
  status: 'OPEN' | 'CLOSED' | 'CLOSED_WITH_DISCREPANCY' | 'HANDED_OVER';
}
export interface PosSaleScope {
  id: string; organizationId: string; branchId: string; warehouseId: string; shiftId: string; cashierUserId: string; status: string;
}

export async function getPosTerminalScope(executor: Queryable, terminalId: string): Promise<PosTerminalScope | null> {
  const result = await executor.query<{ id: string; organization_id: string; branch_id: string; warehouse_id: string; code: string; name: string; status: 'ACTIVE' | 'INACTIVE' }>(
    'SELECT id, organization_id, branch_id, warehouse_id, code, name, status FROM pos.pos_terminal WHERE id = $1', [terminalId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, organizationId: row.organization_id, branchId: row.branch_id, warehouseId: row.warehouse_id, code: row.code, name: row.name, status: row.status } : null;
}

export async function getPosShiftScope(executor: Queryable, shiftId: string): Promise<PosShiftScope | null> {
  const result = await executor.query<{
    id: string; organization_id: string; branch_id: string; warehouse_id: string; terminal_id: string; cashier_user_id: string; status: PosShiftScope['status'];
  }>(
    `SELECT s.id, s.organization_id, t.branch_id, t.warehouse_id, s.terminal_id, s.cashier_user_id, s.status
     FROM pos.pos_shift s JOIN pos.pos_terminal t ON t.id = s.terminal_id WHERE s.id = $1`, [shiftId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, organizationId: row.organization_id, branchId: row.branch_id, warehouseId: row.warehouse_id,
    terminalId: row.terminal_id, cashierUserId: row.cashier_user_id, status: row.status,
  } : null;
}

export async function getPosSaleScope(executor: Queryable, saleId: string): Promise<PosSaleScope | null> {
  const result = await executor.query<{
    id: string; organization_id: string; branch_id: string; warehouse_id: string; shift_id: string; cashier_user_id: string; status: string;
  }>(
    `SELECT sale.id, sale.organization_id, t.branch_id, t.warehouse_id, sale.shift_id, s.cashier_user_id, sale.status
     FROM pos.pos_sale sale JOIN pos.pos_shift s ON s.id = sale.shift_id JOIN pos.pos_terminal t ON t.id = sale.terminal_id
     WHERE sale.id = $1`, [saleId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, organizationId: row.organization_id, branchId: row.branch_id, warehouseId: row.warehouse_id,
    shiftId: row.shift_id, cashierUserId: row.cashier_user_id, status: row.status,
  } : null;
}

export interface PosTerminalOption extends PosTerminalScope { inUse: boolean }

/** Active terminals of an organization, with whether each already has an OPEN shift. The caller filters by scope. */
export async function listPosTerminals(executor: Queryable, organizationId: string): Promise<PosTerminalOption[]> {
  const result = await executor.query<{ id: string; organization_id: string; branch_id: string; warehouse_id: string; code: string; name: string; status: 'ACTIVE' | 'INACTIVE'; in_use: boolean }>(
    `SELECT t.id, t.organization_id, t.branch_id, t.warehouse_id, t.code, t.name, t.status,
            EXISTS (SELECT 1 FROM pos.pos_shift s WHERE s.terminal_id = t.id AND s.status = 'OPEN') AS in_use
     FROM pos.pos_terminal t WHERE t.organization_id = $1 AND t.status = 'ACTIVE' ORDER BY t.code`, [organizationId],
  );
  return result.rows.map((row) => ({
    id: row.id, organizationId: row.organization_id, branchId: row.branch_id, warehouseId: row.warehouse_id,
    code: row.code, name: row.name, status: row.status, inUse: row.in_use,
  }));
}

export interface PosSaleLineRow { id: string; productId: string; sku: string; name: string; uom: string; qty: string; unitPrice: string; lineTotal: string }
export interface PosSaleRow {
  id: string; number: string | null; status: string; customerId: string | null;
  subtotal: string; taxTotal: string; total: string; invoiceNumber: string | null;
}
export interface PosSaleDetail extends PosSaleRow {
  lines: PosSaleLineRow[];
  tender: { method: 'TUNAI'; amount: string; cashReceived: string; changeAmount: string; acceptedAt: string } | null;
}

export async function getPosSale(executor: Queryable, saleId: string): Promise<PosSaleDetail | null> {
  const sale = await executor.query<{
    id: string; number: string | null; status: string; customer_id: string | null;
    subtotal: string; tax_total: string; total: string; invoice_number: string | null;
  }>('SELECT id, number, status, customer_id, subtotal::text, tax_total::text, total::text, invoice_number FROM pos.pos_sale WHERE id = $1', [saleId]);
  const row = sale.rows[0];
  if (!row) return null;
  const lines = await executor.query<{ id: string; product_id: string; sku: string; name: string; uom: string; qty: string; unit_price: string; line_total: string }>(
    'SELECT id, product_id, sku, name, uom, qty::text, unit_price::text, line_total::text FROM pos.pos_sale_line WHERE sale_id = $1 ORDER BY created_at, id', [saleId],
  );
  const tender = await executor.query<{ amount: string; cash_received: string; change_amount: string; accepted_at: Date }>(
    `SELECT amount::text, cash_received::text, change_amount::text, accepted_at FROM pos.pos_tender
     WHERE sale_id = $1 AND status = 'ACCEPTED' AND method = 'TUNAI' ORDER BY accepted_at LIMIT 1`, [saleId],
  );
  const tenderRow = tender.rows[0];
  return {
    id: row.id, number: row.number, status: row.status, customerId: row.customer_id,
    subtotal: row.subtotal, taxTotal: row.tax_total, total: row.total, invoiceNumber: row.invoice_number,
    lines: lines.rows.map((line) => ({
      id: line.id, productId: line.product_id, sku: line.sku, name: line.name, uom: line.uom,
      qty: line.qty, unitPrice: line.unit_price, lineTotal: line.line_total,
    })),
    tender: tenderRow ? {
      method: 'TUNAI', amount: tenderRow.amount, cashReceived: tenderRow.cash_received, changeAmount: tenderRow.change_amount,
      acceptedAt: tenderRow.accepted_at.toISOString(),
    } : null,
  };
}

export interface PosReceipt {
  saleId: string; invoiceNumber: string; terminalCode: string; terminalName: string; cashierUserId: string;
  paidAt: string; copyNumber: number; isCopy: boolean;
  lines: PosSaleLineRow[]; subtotal: string; taxTotal: string; total: string; cashReceived: string; changeAmount: string;
}

/** POS-011 receipt content for the latest recorded print. `isCopy` is true from the second print on ("SALINAN"). */
export async function getPosReceipt(executor: Queryable, saleId: string): Promise<PosReceipt | null> {
  const head = await executor.query<{
    invoice_number: string | null; code: string; name: string; cashier_user_id: string; paid_at: Date | null; copy_number: number | null;
  }>(
    `SELECT sale.invoice_number, t.code, t.name, s.cashier_user_id, sale.paid_at,
            (SELECT max(copy_number) FROM pos.pos_receipt_print p WHERE p.sale_id = sale.id) AS copy_number
     FROM pos.pos_sale sale JOIN pos.pos_shift s ON s.id = sale.shift_id JOIN pos.pos_terminal t ON t.id = sale.terminal_id
     WHERE sale.id = $1`, [saleId],
  );
  const row = head.rows[0];
  const detail = await getPosSale(executor, saleId);
  if (!row || !detail || !detail.tender || !row.invoice_number || !row.paid_at || row.copy_number === null) return null;
  return {
    saleId, invoiceNumber: row.invoice_number, terminalCode: row.code, terminalName: row.name, cashierUserId: row.cashier_user_id,
    paidAt: row.paid_at.toISOString(), copyNumber: row.copy_number, isCopy: row.copy_number > 1,
    lines: detail.lines, subtotal: detail.subtotal, taxTotal: detail.taxTotal, total: detail.total,
    cashReceived: detail.tender.cashReceived, changeAmount: detail.tender.changeAmount,
  };
}

export interface ShiftSaya {
  shift: {
    id: string; terminalId: string; terminalCode: string; terminalName: string; status: string; openingFloat: string;
    expectedCash: string | null; countedCash: string | null; variance: string | null;
    cashSalesTotal: string; paidSaleCount: number; openedAt: string;
  } | null;
  openSales: PosSaleDetail[];
}

/**
 * GET /kasir/shift-saya: the cashier's current shift — the OPEN one (POS-000.R08: at most one), or
 * else a CLOSED one whose cash is not yet handed over, so the screen can offer Serah Kas — plus any
 * sale still in the cart or awaiting payment.
 */
export async function getShiftSaya(executor: Queryable, cashierUserId: string): Promise<ShiftSaya> {
  const shift = await executor.query<{
    id: string; terminal_id: string; code: string; name: string; status: string; opening_float: string;
    expected_cash: string | null; counted_cash: string | null; variance: string | null; opened_at: Date;
    cash_sales_total: string; paid_sale_count: number;
  }>(
    `SELECT s.id, s.terminal_id, t.code, t.name, s.status, s.opening_float::text, s.expected_cash::text, s.counted_cash::text,
            s.variance::text, s.opened_at,
            COALESCE((SELECT SUM(tn.amount) FROM pos.pos_tender tn JOIN pos.pos_sale sale ON sale.id = tn.sale_id
                      WHERE sale.shift_id = s.id AND tn.method = 'TUNAI' AND tn.status = 'ACCEPTED'), 0)::numeric(18,2)::text AS cash_sales_total,
            (SELECT count(*)::int FROM pos.pos_sale sale WHERE sale.shift_id = s.id AND sale.status IN ('PAID', 'HANDED_OVER')) AS paid_sale_count
     FROM pos.pos_shift s JOIN pos.pos_terminal t ON t.id = s.terminal_id
     WHERE s.cashier_user_id = $1 AND s.status IN ('OPEN', 'CLOSED', 'CLOSED_WITH_DISCREPANCY')
     ORDER BY (s.status = 'OPEN') DESC, s.opened_at DESC LIMIT 1`, [cashierUserId],
  );
  const row = shift.rows[0];
  if (!row) return { shift: null, openSales: [] };

  const openSaleIds = await executor.query<{ id: string }>(
    "SELECT id FROM pos.pos_sale WHERE shift_id = $1 AND status IN ('CART', 'PENDING_PAYMENT') ORDER BY created_at", [row.id],
  );
  const openSales: PosSaleDetail[] = [];
  for (const sale of openSaleIds.rows) {
    const detail = await getPosSale(executor, sale.id);
    if (detail) openSales.push(detail);
  }
  return {
    shift: {
      id: row.id, terminalId: row.terminal_id, terminalCode: row.code, terminalName: row.name, status: row.status,
      openingFloat: row.opening_float, expectedCash: row.expected_cash, countedCash: row.counted_cash, variance: row.variance,
      cashSalesTotal: row.cash_sales_total, paidSaleCount: row.paid_sale_count, openedAt: row.opened_at.toISOString(),
    },
    openSales,
  };
}

export interface PickupAwaitingHandover {
  saleId: string; branchId: string; warehouseId: string; invoiceNumber: string; total: string; paidAt: string; lines: PosSaleLineRow[];
}

/** POS-010: PAID counter sales whose goods are still at the counter, oldest first. The caller filters by warehouse scope. */
export async function listPickupsAwaitingHandover(executor: Queryable, organizationId: string): Promise<PickupAwaitingHandover[]> {
  const sales = await executor.query<{ id: string; branch_id: string; warehouse_id: string; invoice_number: string; total: string; paid_at: Date }>(
    `SELECT sale.id, t.branch_id, t.warehouse_id, sale.invoice_number, sale.total::text, sale.paid_at
     FROM pos.pos_sale sale JOIN pos.pos_terminal t ON t.id = sale.terminal_id
     WHERE sale.organization_id = $1 AND sale.status = 'PAID' ORDER BY sale.paid_at LIMIT 100`, [organizationId],
  );
  const pickups: PickupAwaitingHandover[] = [];
  for (const sale of sales.rows) {
    const detail = await getPosSale(executor, sale.id);
    pickups.push({
      saleId: sale.id, branchId: sale.branch_id, warehouseId: sale.warehouse_id, invoiceNumber: sale.invoice_number, total: sale.total,
      paidAt: sale.paid_at.toISOString(), lines: detail?.lines ?? [],
    });
  }
  return pickups;
}
