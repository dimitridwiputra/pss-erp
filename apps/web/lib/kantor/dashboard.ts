import {
  CurrentUserPermissionsResponseSchema, PosDashboardSummaryResponseSchema, ProblemDetailsSchema, StockBalanceListResponseSchema,
} from '@pss/contracts';
import { z } from 'zod';
import type { UpstreamRead, UpstreamTransport } from '../experience/sources';
import { coreTransport, financeTransport } from './transport';

/**
 * The /kantor daily dashboard, composed (MVP_PLAN §4, §7).
 *
 * A dashboard is not a domain: it owns nothing and stores nothing, so it reads other domains'
 * published reads and joins the answers here, in the BFF (PLT-008). No business rule lives in this
 * file — every figure is exactly what the owning domain reported, and the only arithmetic is reading
 * a count and a total a domain already computed.
 *
 * **Every tile answers for itself.** One source being down, slow, or refused blanks its own tile and
 * leaves the rest standing: a warehouse on a bad line still shows the morning's sales, and an
 * operator never has to guess whether a blank tile means "zero" or "not available". An unavailable
 * tile carries a registered problem code and a reason in the operator's language, never a silent
 * empty (AGENTS.md §3.7).
 *
 * The reads are issued together, so one slow source delays the screen once rather than once per tile.
 */

/** The low-stock threshold is a caller input, never a constant inside a query (MVP-OD-17). */
const DEFAULT_LOW_STOCK_MIN_QTY = '10';
const LOW_STOCK_MIN_QTY = process.env.PSS_DASHBOARD_LOW_STOCK_MIN_QTY?.trim() || DEFAULT_LOW_STOCK_MIN_QTY;

/** How many low-stock rows the tile lists. The count beside it is the whole number. */
const LOW_STOCK_PREVIEW = 5;

export type DashboardTile<T> =
  | { readonly state: 'OK'; readonly data: T }
  | { readonly state: 'UNAVAILABLE'; readonly problemCode: string; readonly reason: string };

export interface DashboardSales {
  readonly salesTotal: string;
  readonly saleCount: number;
  readonly undepositedCash: string;
  readonly undepositedPaymentCount: number;
}

export interface DashboardLowStockItem {
  readonly productId: string;
  readonly name: string;
  readonly sku: string;
  readonly uom: string;
  readonly qtyOnHand: string;
}

export interface DashboardLowStock {
  /** The threshold this list was built with, shown so the number is never a mystery. */
  readonly threshold: string;
  readonly total: number;
  readonly items: readonly DashboardLowStockItem[];
}

export interface DashboardStockValue {
  readonly totalValue: string | null;
  readonly unvaluedCount: number;
  readonly balanceCount: number;
}

export interface DashboardGrossProfit {
  readonly today: string;
  readonly monthToDate: string;
}

export interface KantorDashboard {
  /** The business date the tiles report, in Asia/Jakarta. */
  readonly businessDate: string;
  readonly sales: DashboardTile<DashboardSales>;
  readonly lowStock: DashboardTile<DashboardLowStock>;
  readonly stockValue: DashboardTile<DashboardStockValue>;
  readonly grossProfit: DashboardTile<DashboardGrossProfit>;
}

/**
 * PROVISIONAL — MVP-OD-23. The gross-profit tile needs a read that the accounting stream has not
 * published yet, so the path it will answer on and the two fields it must return are stated here, in
 * the one place that changes when that stream answers. The endpoint does not exist yet, the read is
 * refused, and the tile says so in words. If the accounting answer's shape differs, this schema is
 * what changes — the tile above does not care where the numbers came from.
 */
const FINANCE_SUMMARY_PATH = '/finance/summary/daily';
const FinanceGrossProfitSchema = z.strictObject({ today: z.string(), monthToDate: z.string() });

export type DashboardTransports = { readonly core: UpstreamTransport; readonly finance: UpstreamTransport };

export interface ResolveDashboardInput {
  readonly accessToken: string | null;
  /** The business date in Asia/Jakarta, `YYYY-MM-DD`. */
  readonly businessDate: string;
  /** Injected by the tests; the real readers are used otherwise. */
  readonly transports?: DashboardTransports;
}

const REAL_TRANSPORTS: DashboardTransports = { core: coreTransport, finance: financeTransport };

/** Reads a registered problem code out of a refusal, so a tile can report the domain's own reason. */
async function problemCodeOf(response: Response): Promise<string> {
  const parsed = ProblemDetailsSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.code : 'DEPENDENCY_UNAVAILABLE';
}

/**
 * A read's outcome, tagged rather than merged. A union of "the data" and "a problem code" would
 * force a cast at every use, because TypeScript cannot subtract a problem from an unresolved generic;
 * tagging it makes the unavailable case impossible to read as data.
 */
type Read<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problemCode: string };

async function readJson<T>(transport: UpstreamTransport, read: UpstreamRead, schema: z.ZodType<T>): Promise<Read<T>> {
  let response: Response;
  try {
    response = await transport(read);
  } catch {
    // A transport fault is a reported unavailable source, never an empty answer.
    return { ok: false, problemCode: 'DEPENDENCY_UNAVAILABLE' };
  }
  if (!response.ok) return { ok: false, problemCode: await problemCodeOf(response) };
  const parsed = schema.safeParse(await response.json().catch(() => null));
  // A body that no longer matches the published contract is unavailable, not zero. Reading it as an
  // answer is the one failure a dashboard must not have.
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problemCode: 'DEPENDENCY_UNAVAILABLE' };
}

/**
 * The reason under a blank tile: one line, no jargon, and it says what to do.
 *
 * `fallback` covers the one source that is known to be **missing** rather than broken. Every other
 * source gets a transient-sounding message, which would be the wrong thing to say about a read that
 * has not been written yet.
 */
function reasonFor(problemCode: string, subject: string, fallback?: string): string {
  if (problemCode === 'UNAUTHENTICATED') return 'Sesi Anda sudah berakhir. Masuk lagi untuk melihat angka ini.';
  if (problemCode === 'PERMISSION_DENIED') return `Akun Anda tidak punya hak untuk melihat ${subject}.`;
  if (problemCode === 'NOT_FOUND') return `${subject} belum tersedia.`;
  if (problemCode === 'CONFIG_KEY_UNKNOWN' || problemCode === 'FEATURE_DISABLED') return `${subject} belum disiapkan untuk demonstrasi ini.`;
  return fallback ?? `${subject} sedang tidak dapat dimuat. Muat ulang sebentar lagi.`;
}

function unavailable<T>(problemCode: string, subject: string, fallback?: string): DashboardTile<T> {
  return { state: 'UNAVAILABLE', problemCode, reason: reasonFor(problemCode, subject, fallback) };
}

function tileOf<T>(value: Read<T>, subject: string, fallback?: string): DashboardTile<T> {
  return value.ok ? { state: 'OK', data: value.data } : unavailable<T>(value.problemCode, subject, fallback);
}

export async function resolveKantorDashboard(input: ResolveDashboardInput): Promise<KantorDashboard> {
  const transports = input.transports ?? REAL_TRANSPORTS;
  if (!input.accessToken) {
    return {
      businessDate: input.businessDate,
      sales: unavailable('UNAUTHENTICATED', 'penjualan hari ini'),
      lowStock: unavailable('UNAUTHENTICATED', 'stok yang menipis'),
      stockValue: unavailable('UNAUTHENTICATED', 'nilai stok'),
      grossProfit: unavailable('UNAUTHENTICATED', 'laba kotor'),
    };
  }

  const token = input.accessToken;
  // The warehouse comes from the caller's own grants rather than from configuration: a value is scoped
  // per warehouse (MVP-OD-4), and guessing one would either 404 or, worse, show another branch's
  // stock. With none in scope there is nothing to report, and the tiles say so.
  const warehouseId = (await warehousesInScope(transports.core, token))[0] ?? null;
  const [sales, lowStock, stockValue, grossProfit] = await Promise.all([
    readJson(transports.core, { method: 'GET', path: `/pos/reports/summary?date=${input.businessDate}`, accessToken: token },
      PosDashboardSummaryResponseSchema.transform((summary) => ({
        salesTotal: summary.salesTotal,
        saleCount: summary.saleCount,
        undepositedCash: summary.undepositedCash,
        undepositedPaymentCount: summary.undepositedPaymentCount,
      }))),
    warehouseId === null
      ? Promise.resolve<Read<DashboardLowStock>>({ ok: false, problemCode: 'PERMISSION_DENIED' })
      : readJson(transports.core, {
        method: 'GET',
        path: `/inventory/stock-balances?warehouseId=${warehouseId}&maxQty=${LOW_STOCK_MIN_QTY}&sort=qtyOnHand&pageSize=${LOW_STOCK_PREVIEW}`,
        accessToken: token,
      }, StockBalanceListResponseSchema.transform(lowStockOf)),
    warehouseId === null
      ? Promise.resolve<Read<DashboardStockValue>>({ ok: false, problemCode: 'PERMISSION_DENIED' })
      : readJson(transports.core, {
        // `totalValue` is summed in SQL over the whole filtered set, so one row on the page is enough
        // to carry the warehouse's total. `sort=value` puts the most valuable balance on top.
        method: 'GET',
        path: `/inventory/stock-balances?warehouseId=${warehouseId}&sort=value&pageSize=1`,
        accessToken: token,
      }, StockBalanceListResponseSchema.transform(stockValueOf)),
    readJson(transports.finance, { method: 'GET', path: `${FINANCE_SUMMARY_PATH}?date=${input.businessDate}`, accessToken: token },
      FinanceGrossProfitSchema),
  ]);

  return {
    businessDate: input.businessDate,
    sales: tileOf(sales, 'penjualan hari ini'),
    lowStock: tileOf(lowStock, 'stok yang menipis'),
    stockValue: tileOf(stockValue, 'nilai stok'),
    grossProfit: tileOf(
      grossProfit,
      'laba kotor',
      'Bagian Keuangan belum menerbitkan laporan harian untuk demonstrasi ini.',
    ),
  };
}

/**
 * The WAREHOUSE-scoped ids the caller may act on, read from their own grants. An unreadable or
 * malformed answer yields no warehouses: the two stock tiles then report "no warehouse in scope",
 * which is the truth, rather than defaulting to a warehouse id that might belong to someone else.
 */
async function warehousesInScope(core: UpstreamTransport, accessToken: string): Promise<string[]> {
  const grants = await readJson(core, { method: 'GET', path: '/me/permissions', accessToken }, CurrentUserPermissionsResponseSchema);
  if (!grants.ok) return [];
  return [...new Set(grants.data.grants
    .filter((grant) => grant.scopeType === 'WAREHOUSE' && grant.scopeId !== null)
    .map((grant) => grant.scopeId as string))];
}

function lowStockOf(response: z.infer<typeof StockBalanceListResponseSchema>): DashboardLowStock {
  return {
    threshold: LOW_STOCK_MIN_QTY,
    total: response.total,
    items: response.items.map((item) => ({
      productId: item.productId,
      // A balance whose product has been removed still has to render as a row, not as a crash.
      name: item.product?.name ?? 'Barang yang sudah dihapus',
      sku: item.product?.sku ?? '—',
      uom: item.uom,
      qtyOnHand: item.qtyOnHand,
    })),
  };
}

function stockValueOf(response: z.infer<typeof StockBalanceListResponseSchema>): DashboardStockValue {
  return { totalValue: response.totalValue, unvaluedCount: response.unvaluedCount, balanceCount: response.total };
}
