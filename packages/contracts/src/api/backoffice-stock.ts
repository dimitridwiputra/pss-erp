import { z } from 'zod';
import { BusinessDateSchema, DecimalStringSchema, MoneyAmountSchema } from '../primitives';

/**
 * Stok — the back office's stock screens: balances with value, the movement ledger, a goods receipt
 * with a unit cost, and a stock adjustment with a reason (INV-001..006).
 *
 * **A `null` cost is a state, not a missing value.** A receipt may arrive without one (a physical
 * warehouse scan never has one), and then the movement is unvalued: no `unitCost`, no `totalCost`, and
 * `INVENTORY_RECEIVED` published with `unitCost: null` so finance routes it to its exception queue
 * rather than posting a zero (MVP_PLAN §5, AGENTS.md §3.7). The screens show "belum ada harga pokok"
 * for it, never a zero rupiah.
 *
 * Money is a decimal string at the column's own scale — `numeric(18,2)` for a value or a total,
 * `numeric(18,4)` for a unit cost — and never a JSON number (MVP-OD-13).
 *
 * The low-stock threshold is an input, never a constant here: no configuration key for it is
 * registered, and `assertKnownConfigKey` throws for one (MVP-OD-17).
 */

/** `stock_movement.movement_type`. The Stok screen maps these to Indonesian labels. */
export const StockMovementTypeSchema = z.enum(['RECEIVE', 'ISSUE', 'ADJUSTMENT']);

/** A quantity as the ledger stores it: `numeric(18,3)`. */
const PositiveQuantity3Schema = z.string().regex(/^(?:0|[1-9]\d*)\.\d{3}$/, 'Jumlah harus lebih besar dari nol.');
const UnitCost4Schema = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Harga pokok harus angka dengan maksimal 4 desimal.');

/** GET /inventory/stock-balances — MVP-OD-4 scopes the average and the value per warehouse. */
export const StockBalanceListQuerySchema = z.strictObject({
  warehouseId: z.uuid(),
  /**
   * Matches the product's SKU or name.
   *
   * Resolved through `master-data`'s own read, because `core.product` is that domain's table and
   * `stock_balance` cannot match a name itself (AGENTS.md §3.1). A term that matches no product
   * returns an empty page, never the whole warehouse's stock.
   */
  q: z.string().trim().min(1).max(100).optional(),
  productId: z.uuid().optional(),
  /** The "stok menipis" filter. The caller supplies the threshold (MVP-OD-17). */
  maxQty: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  /** Only balances never valued, which finance still has to value. */
  unvaluedOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['product', 'qtyOnHand', 'value']).default('product'),
});
export type StockBalanceListQuery = z.infer<typeof StockBalanceListQuerySchema>;

export const StockBalanceSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string(),
  qtyOnHand: DecimalStringSchema,
  qtyReserved: DecimalStringSchema,
  /** `null` when the balance has never been valued (MVP-OD-16). */
  avgUnitCost: z.string().nullable(),
  /** `qtyOnHand × avgUnitCost`, to 2 places, computed in SQL. `null` when unvalued. */
  stockValue: MoneyAmountSchema.nullable(),
  /** The product this balance is for, joined from `master-data`'s own read. `null` if it is gone. */
  product: z.strictObject({
    productId: z.uuid(), sku: z.string(), name: z.string(), baseUom: z.string(),
  }).nullable(),
});
export const StockBalanceListResponseSchema = z.strictObject({
  warehouseId: z.uuid(),
  items: z.array(StockBalanceSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
  /**
   * Σ value over the whole filtered set. `null` when any balance in it is unvalued, because a total
   * that silently omitted unvalued stock would understate inventory and look like an answer.
   */
  totalValue: MoneyAmountSchema.nullable(),
  /** How many balances in the set carry no value yet, so the screen can say why the total is blank. */
  unvaluedCount: z.int().nonnegative(),
});
export type StockBalanceListResponse = z.infer<typeof StockBalanceListResponseSchema>;

/** GET /inventory/stock-movements — the ledger, newest first. */
export const StockMovementListQuerySchema = z.strictObject({
  warehouseId: z.uuid(),
  /**
   * Matches the product's SKU or name.
   *
   * Resolved through `master-data`'s own read, because `core.product` is that domain's table and the
   * ledger cannot match a name itself (AGENTS.md §3.1). A term that matches no product returns an
   * empty page, never the whole warehouse's movements.
   */
  q: z.string().trim().min(1).max(100).optional(),
  productId: z.uuid().optional(),
  movementType: StockMovementTypeSchema.optional(),
  /** A code from `inventory.stock_adjustment_reason`; only an adjustment has one. */
  reasonCode: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['occurredAt', 'qty', 'value']).default('occurredAt'),
});
export type StockMovementListQuery = z.infer<typeof StockMovementListQuerySchema>;

export const StockMovementSchema = z.strictObject({
  movementId: z.uuid(),
  warehouseId: z.uuid(),
  productId: z.uuid(),
  uom: z.string(),
  movementType: StockMovementTypeSchema,
  /** Signed for an adjustment: a shortage is negative. */
  qty: DecimalStringSchema,
  referenceType: z.string(),
  referenceId: z.uuid(),
  reasonCode: z.string().nullable(),
  /** The reason's Indonesian label, or null. A code is never shown raw (PRD Appendix F.3). */
  reasonLabel: z.string().nullable(),
  unitCost: z.string().nullable(),
  totalCost: MoneyAmountSchema.nullable(),
  occurredAt: z.iso.datetime(),
  product: z.strictObject({
    productId: z.uuid(), sku: z.string(), name: z.string(), baseUom: z.string(),
  }).nullable(),
});
export const StockMovementListResponseSchema = z.strictObject({
  warehouseId: z.uuid(),
  items: z.array(StockMovementSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
});
export type StockMovementListResponse = z.infer<typeof StockMovementListResponseSchema>;

/** GET /inventory/stock-adjustment-reasons — the reason picker's options, with their labels. */
export const StockAdjustmentReasonSchema = z.strictObject({ code: z.string(), label: z.string() });
export const StockAdjustmentReasonListResponseSchema = z.strictObject({
  items: z.array(StockAdjustmentReasonSchema),
});
export type StockAdjustmentReasonListResponse = z.infer<typeof StockAdjustmentReasonListResponseSchema>;

/** POST /inventory/warehouses/{warehouseId}/goods-receipts — WMS-003 without a PO, with a cost. */

export const GoodsReceiptRequestSchema = z.strictObject({
  /** The receipt document. Optional, and generated when absent so a single quick receipt needs no id. */
  sourceId: z.uuid().optional(),
  /** Defaults to today in Asia/Jakarta when absent; pass it to post a dated document. */
  businessDate: BusinessDateSchema.optional(),
  lines: z.array(z.strictObject({
    productId: z.uuid(),
    uom: z.string().trim().min(1).max(16),
    qty: PositiveQuantity3Schema,
    /** Omitted means the line is received UNVALUED and finance is told (MVP-OD-16). */
    unitCost: UnitCost4Schema.nullish(),
  })).min(1),
});
export type GoodsReceiptRequest = z.infer<typeof GoodsReceiptRequestSchema>;

export const GoodsReceiptResponseSchema = z.strictObject({
  warehouseId: z.uuid(),
  movementIds: z.array(z.uuid()).min(1),
  /** How many lines came in without a cost, so the screen can say why finance will ask. */
  unvaluedLineCount: z.int().nonnegative(),
});
export type GoodsReceiptResponse = z.infer<typeof GoodsReceiptResponseSchema>;

/** POST /inventory/warehouses/{warehouseId}/stock-adjustments — `inventory.adjustment.request`. */
export const StockAdjustmentRequestSchema = z.strictObject({
  businessDate: BusinessDateSchema.optional(),
  lines: z.array(z.strictObject({
    productId: z.uuid(),
    uom: z.string().trim().min(1).max(16),
    /** Signed: a surplus is positive, a shortage negative. Zero is refused — a correction of nothing is a mistake. */
    qtyDelta: z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{3}$/, 'Selisih harus angka dengan 3 desimal, dan tidak boleh nol.'),
    /** An active code from `inventory.stock_adjustment_reason`; the screen offers only those. */
    reasonCode: z.string().trim().min(1).max(64),
  })).min(1),
});
export type StockAdjustmentRequest = z.infer<typeof StockAdjustmentRequestSchema>;

export const StockAdjustmentResponseSchema = z.strictObject({
  warehouseId: z.uuid(),
  movementIds: z.array(z.uuid()).min(1),
});
export type StockAdjustmentResponse = z.infer<typeof StockAdjustmentResponseSchema>;
