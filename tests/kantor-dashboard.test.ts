import { describe, expect, it } from 'vitest';
import { resolveKantorDashboard, type DashboardTransports } from '../apps/web/lib/kantor/dashboard';
import type { UpstreamRead, UpstreamTransport } from '../apps/web/lib/experience/sources';

/**
 * The /kantor daily dashboard's composition.
 *
 * A dashboard's one real job is not arithmetic — it is not lying. A tile that is unavailable must say
 * so, must not render as zero, and one broken source must not blank the tiles that are fine. These
 * tests pin exactly that, because nothing else in the system would catch it: a dashboard that shows
 * Rp 0 for "belum ada harga pokok" is indistinguishable, on a screen, from a business that sold
 * nothing.
 */

const USER_ID = '019a0000-0000-7000-8000-000000000001';
const WAREHOUSE_ID = '019a0000-0000-7000-8000-000000000002';
const PRODUCT_ID = '019a0000-0000-7000-8000-000000000003';
const BUSINESS_DATE = '2026-09-30';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A registered refusal, shaped exactly as `ProblemDetailsSchema` requires so the code survives. */
function refusal(code: string, status: number): () => Response {
  return () => json({
    type: 'https://pss.example/problems/' + code.toLowerCase(),
    title: 'Permintaan ditolak',
    status,
    detail: 'refusal',
    instance: '/test',
    code,
    message: 'Permintaan ditolak.',
    requestId: 'request-1',
    correlationId: 'request-1',
    permittedActions: [],
    retryable: false,
  }, status);
}

const grants = {
  userId: USER_ID,
  grants: [
    { permission: 'pos.report.view', scopeType: 'WAREHOUSE' as const, scopeId: WAREHOUSE_ID },
    { permission: 'master_data.product.manage', scopeType: 'ORGANIZATION' as const, scopeId: null },
  ],
};

const posSummary = {
  businessDate: BUSINESS_DATE,
  salesTotal: '236000.00',
  saleCount: 2,
  undepositedCash: '236000.00',
  undepositedPaymentCount: 1,
};

const balances = {
  warehouseId: WAREHOUSE_ID,
  items: [{
    productId: PRODUCT_ID,
    uom: 'KARTON',
    qtyOnHand: '4.000',
    qtyReserved: '0.000',
    avgUnitCost: '95000.0000',
    stockValue: '380000.00',
    product: { productId: PRODUCT_ID, sku: 'DEMO-001', name: 'Mi Goreng 80g', baseUom: 'PCS' },
  }],
  page: 1,
  pageSize: 25,
  total: 1,
  hasMore: false,
  totalValue: '40732000.00',
  unvaluedCount: 0,
};

/** A transport that answers a fixed path map, records what was read, and faults on anything else. */
function transportOf(responses: Record<string, Response | (() => Response)>, reads: UpstreamRead[]): UpstreamTransport {
  return async (read) => {
    reads.push(read);
    const answer = responses[read.path];
    if (!answer) throw new Error(`Unexpected read: ${read.path}`);
    return typeof answer === 'function' ? answer() : answer;
  };
}

function transportsOf(core: Record<string, Response | (() => Response)>, finance: Record<string, Response | (() => Response)> = {}) {
  const coreReads: UpstreamRead[] = [];
  const financeReads: UpstreamRead[] = [];
  const transports: DashboardTransports = {
    core: transportOf(core, coreReads),
    finance: transportOf(finance, financeReads),
  };
  return { transports, coreReads, financeReads };
}

const happyCore = {
  '/me/permissions': () => json(grants),
  [`/pos/reports/summary?date=${BUSINESS_DATE}`]: () => json(posSummary),
  [`/inventory/stock-balances?warehouseId=${WAREHOUSE_ID}&maxQty=10&sort=qtyOnHand&pageSize=5`]: () => json(balances),
  [`/inventory/stock-balances?warehouseId=${WAREHOUSE_ID}&sort=value&pageSize=1`]: () => json(balances),
};

describe('kantor dashboard: composition', () => {
  it('reports every tile from the owning domain, and computes nothing itself', async () => {
    const { transports, coreReads } = transportsOf(happyCore, {
      [`/finance/summary/daily?date=${BUSINESS_DATE}`]: () => json({ today: '46000.00', monthToDate: '120000.00' }),
    });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    expect(dashboard.businessDate).toBe(BUSINESS_DATE);
    // Sales and undeposited cash are one domain's answer, passed through unchanged: not summed, not
    // averaged, not turned into a percentage.
    expect(dashboard.sales).toEqual({
      state: 'OK',
      data: { salesTotal: '236000.00', saleCount: 2, undepositedCash: '236000.00', undepositedPaymentCount: 1 },
    });
    expect(dashboard.stockValue).toEqual({ state: 'OK', data: { totalValue: '40732000.00', unvaluedCount: 0, balanceCount: 1 } });
    expect(dashboard.grossProfit).toEqual({ state: 'OK', data: { today: '46000.00', monthToDate: '120000.00' } });
    // The threshold the low-stock tile was built with travels with the answer, so the screen can show
    // the number it used rather than an unexplained list (MVP-OD-17).
    expect(dashboard.lowStock).toMatchObject({ state: 'OK', data: { threshold: '10', total: 1 } });
    expect(dashboard.lowStock.state === 'OK' && dashboard.lowStock.data.items[0]?.name).toBe('Mi Goreng 80g');

    // Every read is a GET through the session token; the token is forwarded, never replaced.
    expect(coreReads.every((read) => read.method === 'GET' && read.accessToken === 'token')).toBe(true);
  });

  it('keeps a working tile standing when one source is refused', async () => {
    const { transports } = transportsOf({
      ...happyCore,
      [`/inventory/stock-balances?warehouseId=${WAREHOUSE_ID}&maxQty=10&sort=qtyOnHand&pageSize=5`]: () => refusal('DEPENDENCY_UNAVAILABLE', 503)(),
    });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    // The sales tile is a separate read and must survive the stock read failing.
    expect(dashboard.sales.state).toBe('OK');
    expect(dashboard.stockValue.state).toBe('OK');
    expect(dashboard.lowStock).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' });
    if (dashboard.lowStock.state === 'UNAVAILABLE') {
      // A reason in the operator's language, never a code and never a blank.
      expect(dashboard.lowStock.reason).toContain('stok yang menipis');
      expect(dashboard.lowStock.reason).not.toContain('DEPENDENCY_UNAVAILABLE');
    }
  });

  it('reports the gross-profit tile as unavailable while the accounting read does not exist (MVP-OD-23)', async () => {
    const { transports } = transportsOf(happyCore, {
      [`/finance/summary/daily?date=${BUSINESS_DATE}`]: () => refusal('NOT_FOUND', 404)(),
    });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    // The tile is present and says so. It is never rendered as Rp 0, which would read as "no profit".
    expect(dashboard.grossProfit).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'NOT_FOUND' });
    expect(dashboard.sales.state).toBe('OK');
  });

  it('names the missing source when the accounting read cannot be reached at all', async () => {
    // The finance API is not running: a transport fault, not a refusal. "Sedang tidak dapat dimuat"
    // would be the wrong sentence for a read that has not been written yet, so the tile says who owes
    // it instead — and the registered code is still the honest DEPENDENCY_UNAVAILABLE.
    const { transports } = transportsOf(happyCore);

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    expect(dashboard.grossProfit).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' });
    if (dashboard.grossProfit.state === 'UNAVAILABLE') {
      expect(dashboard.grossProfit.reason).toContain('Keuangan');
      expect(dashboard.grossProfit.reason).not.toContain('Muat ulang');
    }
    // And the reason a *transient* source gets is still the transient one.
    expect(dashboard.stockValue).toMatchObject({ state: 'OK' });
  });

  it('treats a body that no longer matches the contract as unavailable, not as an answer', async () => {
    const { transports } = transportsOf({
      ...happyCore,
      [`/pos/reports/summary?date=${BUSINESS_DATE}`]: () => json({ businessDate: BUSINESS_DATE, salesTotal: '236000.00' }),
    });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    // A dropped field is a broken deployment, not zero sales.
    expect(dashboard.sales).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('reports no warehouse in scope rather than reporting a stock figure it could not scope', async () => {
    const { transports, coreReads } = transportsOf({ '/me/permissions': () => json({ userId: USER_ID, grants: [] }) });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    expect(dashboard.lowStock).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'PERMISSION_DENIED' });
    expect(dashboard.stockValue).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'PERMISSION_DENIED' });
    // The sales tile is independent of the warehouse and still answers.
    expect(dashboard.sales.state).toBe('UNAVAILABLE');
    // And no stock read was attempted at all, rather than attempted against a guessed warehouse.
    expect(coreReads.some((read) => read.path.startsWith('/inventory/'))).toBe(false);
  });

  it('reports an unauthenticated caller as signed out, on every tile', async () => {
    const { coreReads } = transportsOf(happyCore);

    const dashboard = await resolveKantorDashboard({ accessToken: null, businessDate: BUSINESS_DATE, transports: transportsOf(happyCore).transports });

    for (const tile of [dashboard.sales, dashboard.lowStock, dashboard.stockValue, dashboard.grossProfit]) {
      expect(tile).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'UNAUTHENTICATED' });
      if (tile.state === 'UNAVAILABLE') expect(tile.reason).toContain('Masuk lagi');
    }
    expect(coreReads).toHaveLength(0);
  });

  it('reads the warehouse from the caller’s own grants, never from a guess', async () => {
    const other = '019a0000-0000-7000-8000-0000000000ff';
    const { transports, coreReads } = transportsOf({
      ...happyCore,
      '/me/permissions': () => json({
        userId: USER_ID,
        grants: [
          { permission: 'procurement.receipt.post', scopeType: 'WAREHOUSE', scopeId: other },
          { permission: 'pos.shift.open', scopeType: 'WAREHOUSE', scopeId: other },
        ],
      }),
    });

    await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    const stockReads = coreReads.filter((read) => read.path.startsWith('/inventory/stock-balances'));
    expect(stockReads.length).toBeGreaterThan(0);
    expect(stockReads.every((read) => read.path.includes(other))).toBe(true);
  });

  it('survives a transport that throws, on the source that threw', async () => {
    const { transports } = transportsOf({
      ...happyCore,
      [`/inventory/stock-balances?warehouseId=${WAREHOUSE_ID}&sort=value&pageSize=1`]: () => { throw new Error('ECONNREFUSED'); },
    });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    expect(dashboard.stockValue).toMatchObject({ state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(dashboard.lowStock.state).toBe('OK');
    expect(dashboard.sales.state).toBe('OK');
  });

  it('leaves an unvalued stock total blank and says how many balances are unvalued', async () => {
    const { transports } = transportsOf({
      ...happyCore,
      [`/inventory/stock-balances?warehouseId=${WAREHOUSE_ID}&sort=value&pageSize=1`]: () => json({
        ...balances,
        items: [{ ...balances.items[0], avgUnitCost: null, stockValue: null }],
        totalValue: null,
        unvaluedCount: 3,
      }),
    });

    const dashboard = await resolveKantorDashboard({ accessToken: 'token', businessDate: BUSINESS_DATE, transports });

    // A total that silently omitted unvalued stock would understate the warehouse and look like an
    // answer (MVP-OD-16), so it is null and the count comes with it.
    expect(dashboard.stockValue).toEqual({ state: 'OK', data: { totalValue: null, unvaluedCount: 3, balanceCount: 1 } });
  });
});
