import type { Page, Route } from '@playwright/test';

/**
 * A stateful stand-in for the POS API behind the BFF (`/api/bff/core/*`), so the counter screen can
 * be exercised in CI without Keycloak or a database. The real contract is covered end to end by
 * `apps/api/tests/pos.integration.test.ts`; this fixture only answers with the same shapes.
 */
const shiftId = '0199a000-0000-7000-8000-0000000000a1';
const terminalId = '0199a000-0000-7000-8000-0000000000a2';
const saleId = '0199a000-0000-7000-8000-0000000000a3';
const lineId = '0199a000-0000-7000-8000-0000000000a4';

const problem = (status: number, code: string, title: string, message: string) => ({
  type: `/errors/${code}`, title, status, detail: message, instance: '/test', code, message,
  requestId: 'req-test', correlationId: 'req-test', permittedActions: [], retryable: false,
});

export interface KasirMock { requests: { method: string; path: string; idempotencyKey: string | null }[] }

export async function mockKasirApi(page: Page, options: { canCount?: boolean; canPickup?: boolean; disabled?: boolean; signedOut?: boolean } = {}): Promise<KasirMock> {
  const { canCount = true, canPickup = false, disabled = false, signedOut = false } = options;
  const state = { shiftOpen: false, qty: 0, saleStatus: 'CART' as 'CART' | 'PENDING_PAYMENT' | 'PAID', saleExists: false };
  const mock: KasirMock = { requests: [] };

  const shift = () => ({
    id: shiftId, terminalId, terminalCode: 'KSR-01', terminalName: 'Konter 1', status: 'OPEN', openingFloat: '500000.00',
    expectedCash: null, countedCash: null, variance: null, cashSalesTotal: '0.00', paidSaleCount: 0, openedAt: '2026-10-01T01:00:00.000Z',
  });
  const total = () => `${118000 * state.qty}.00`;
  const sale = () => ({
    id: saleId, number: null, status: state.saleStatus, customerId: null,
    lines: state.qty ? [{ id: lineId, productId: '0199a000-0000-7000-8000-0000000000a5', sku: 'DEMO-001', name: 'Mi Goreng 80g', uom: 'KARTON', qty: `${state.qty}.000`, unitPrice: '118000.00', lineTotal: total() }] : [],
    subtotal: total(), taxTotal: '0.00', total: total(), invoiceNumber: state.saleStatus === 'CART' ? null : 'INV-DMO-2026-000001', tender: null,
  });

  await page.route('**/api/bff/core/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/bff/core', '');
    const method = request.method();
    mock.requests.push({ method, path, idempotencyKey: request.headers()['idempotency-key'] ?? null });
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (signedOut) return json(401, problem(401, 'UNAUTHENTICATED', 'Sesi berakhir', 'Silakan masuk lagi.'));
    if (disabled) return json(403, problem(403, 'FEATURE_DISABLED', 'Fitur belum aktif', 'Fitur ini belum diaktifkan di lingkungan ini. Hubungi admin.'));
    if (path === '/pos/pickups') return canPickup ? json(200, { items: [] }) : json(403, problem(403, 'PERMISSION_DENIED', 'Tidak diizinkan', 'Di luar akses Anda.'));
    if (!canCount) return json(403, problem(403, 'PERMISSION_DENIED', 'Tidak diizinkan', 'Di luar akses Anda.'));

    if (path === '/kasir/shift-saya') return json(200, { shift: state.shiftOpen ? shift() : null, openSales: [] });
    if (path === '/kasir/terminals') return json(200, { items: [{ id: terminalId, branchId: shiftId, warehouseId: shiftId, code: 'KSR-01', name: 'Konter 1', status: 'ACTIVE', inUse: false }] });
    if (path === '/pos/shifts' && method === 'POST') { state.shiftOpen = true; return json(201, { ...shift(), expectedCash: null }); }
    if (path === '/pos/sales' && method === 'POST') { state.saleExists = true; return json(201, { id: saleId, status: 'CART' }); }
    if (path === `/pos/sales/${saleId}` && method === 'GET') return json(200, sale());
    if (path === `/pos/sales/${saleId}/lines` && method === 'POST') {
      const body = request.postDataJSON() as { barcode: string };
      if (body.barcode !== '8990001000012') return json(404, problem(404, 'NOT_FOUND', 'Barang tidak ditemukan', 'Barcode ini belum terdaftar.'));
      state.qty += 1;
      return json(201, { ...sale().lines[0], saleTotal: total() });
    }
    if (path === `/pos/sales/${saleId}/checkout`) { state.saleStatus = 'PENDING_PAYMENT'; return json(201, { id: saleId, status: 'PENDING_PAYMENT', salesOrderId: shiftId, invoiceNumber: 'INV-DMO-2026-000001', total: total() }); }
    if (path === `/pos/sales/${saleId}/tenders`) {
      state.saleStatus = 'PAID';
      return json(201, { tender: { id: lineId, method: 'TUNAI', status: 'ACCEPTED', amount: total(), cashReceived: '250000.00', changeAmount: '14000.00' }, sale: { id: saleId, status: 'PAID' } });
    }
    if (path === `/pos/sales/${saleId}/receipt-prints`) {
      return json(201, {
        saleId, invoiceNumber: 'INV-DMO-2026-000001', terminalCode: 'KSR-01', terminalName: 'Konter 1', cashierUserId: shiftId,
        paidAt: '2026-10-01T03:00:00.000Z', copyNumber: 1, isCopy: false, lines: sale().lines,
        subtotal: total(), taxTotal: '0.00', total: total(), cashReceived: '250000.00', changeAmount: '14000.00',
      });
    }
    return json(404, problem(404, 'NOT_FOUND', 'Tidak ditemukan', `Tidak ada tiruan untuk ${method} ${path}.`));
  });
  return mock;
}
