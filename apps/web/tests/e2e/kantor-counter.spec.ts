import { expect, test, type Page } from '@playwright/test';

/**
 * /kantor/penjualan and /kantor/setoran-kas against a stand-in for the BFF, as in kasir.fixture.ts.
 * The routes themselves are covered end to end by apps/api/tests/pos.integration.test.ts.
 */
const handoverId = '0199a000-0000-7000-8000-0000000000b1';
const saleId = '0199a000-0000-7000-8000-0000000000b2';
const uuid = '0199a000-0000-7000-8000-0000000000b3';

async function json(page: Page, pattern: string, handler: (body: unknown) => { status?: number; body: unknown }) {
  await page.route(pattern, async (route) => {
    const result = handler(route.request().postDataJSON?.() ?? null);
    await route.fulfill({ status: result.status ?? 200, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
}

test('the finance cashier counts a short handover, must give a reason, and it moves to "Sudah diterima"', async ({ page }) => {
  let verified: { countedAmount: string; reasonCode?: string } | null = null;
  const handover = (status: string) => ({
    id: handoverId, status, declaredAmount: '248000.00', countedAmount: verified ? '247000.00' : null,
    varianceAmount: verified ? '-1000.00' : null, reasonCode: verified?.reasonCode ?? null, paymentCount: 1,
    declaredAt: '2026-10-01T09:00:00.000Z', verifiedAt: verified ? '2026-10-01T10:00:00.000Z' : null,
    collectorName: 'Kasir Demo', verifierName: verified ? 'Staf Keuangan Demo' : null,
    shift: { id: uuid, terminalName: 'Konter 1', openingFloat: '500000.00', countedCash: '747000.00', closeVariance: '-1000.00' },
  });
  await json(page, '**/api/bff/core/payments/cash-handovers?*', () => ({
    body: { page: 1, pageSize: 50, total: verified ? 0 : 1, items: verified ? [] : [handover('DECLARED')] },
  }));
  await json(page, `**/api/bff/core/payments/cash-handovers/${handoverId}/verify`, (body) => {
    verified = body as { countedAmount: string; reasonCode?: string };
    return { body: handover('VERIFIED') };
  });

  await page.goto('/kantor/setoran-kas');
  await page.getByRole('button', { name: /Konter 1 · Kasir Demo/ }).click();
  await expect(page.getByText('Hitungan kasir saat tutup shift')).toBeVisible();
  await page.getByLabel('Uang yang Anda hitung').fill('247000');
  await expect(page.getByText(/Uang kurang Rp\s1\.000 dari yang tercatat/)).toBeVisible();
  const accept = page.getByRole('button', { name: /Terima Setoran/ });
  await expect(accept).toBeDisabled();
  await page.getByRole('button', { name: 'Uang kurang' }).click();
  await accept.click();
  await expect(page.getByRole('status')).toContainText('sudah diterima');
  expect(verified).toEqual({ countedAmount: '247000', reasonCode: 'RC-CSH-COUNT_SHORT' });
});

test('Setoran Kas shows the server refusal copy when the verifier handed the money over (SOD-06)', async ({ page }) => {
  await json(page, '**/api/bff/core/payments/cash-handovers?*', () => ({
    body: { page: 1, pageSize: 50, total: 1, items: [{
      id: handoverId, status: 'DECLARED', declaredAmount: '118000.00', countedAmount: null, varianceAmount: null, reasonCode: null,
      paymentCount: 1, declaredAt: '2026-10-01T09:00:00.000Z', verifiedAt: null, collectorName: 'Kasir Demo', verifierName: null, shift: null,
    }] },
  }));
  await json(page, `**/api/bff/core/payments/cash-handovers/${handoverId}/verify`, () => ({
    status: 403,
    body: { type: '/errors/SEGREGATION_OF_DUTIES', title: 'Tidak boleh oleh orang yang sama', status: 403, detail: 'x', instance: '/x',
      code: 'SEGREGATION_OF_DUTIES', message: 'Setoran harus dihitung orang lain.', requestId: 'r', correlationId: 'r', permittedActions: [], retryable: false },
  }));
  await page.goto('/kantor/setoran-kas');
  await page.getByRole('button', { name: /Kasir Demo/ }).click();
  await page.getByLabel('Uang yang Anda hitung').fill('118000');
  await page.getByRole('button', { name: /Terima Setoran/ }).click();
  await expect(page.locator('.pos-callout-danger')).toContainText('Setoran harus dihitung orang lain.');
});

test('Penjualan lists the day, opens a sale, and prints a copy marked SALINAN', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => undefined; });
  const line = { id: uuid, productId: uuid, sku: 'DEMO-001', name: 'Mi Goreng 80g', uom: 'KARTON', qty: '2.000', unitPrice: '118000.00', lineTotal: '236000.00' };
  await json(page, '**/api/bff/core/pos/reports/sales?*', () => ({
    body: { page: 1, pageSize: 25, total: 1, items: [{
      saleId, invoiceNumber: 'INV-DMO-2026-000001', status: 'HANDED_OVER', total: '236000.00', checkedOutAt: '2026-10-01T03:00:00.000Z',
      paidAt: '2026-10-01T03:01:00.000Z', handedOverAt: '2026-10-01T03:10:00.000Z', shiftId: uuid, cashierUserId: uuid,
      cashierName: 'Kasir Demo', terminalCode: 'KSR-01', terminalName: 'Konter 1',
    }] },
  }));
  await json(page, `**/api/bff/core/pos/reports/sales/${saleId}`, () => ({
    body: {
      sale: { id: saleId, number: null, status: 'HANDED_OVER', customerId: uuid, lines: [line], subtotal: '236000.00', taxTotal: '0.00', total: '236000.00',
        invoiceNumber: 'INV-DMO-2026-000001', tender: { method: 'TUNAI', amount: '236000.00', cashReceived: '250000.00', changeAmount: '14000.00', acceptedAt: '2026-10-01T03:01:00.000Z' } },
      terminalName: 'Konter 1', cashierName: 'Kasir Demo', checkedOutAt: '2026-10-01T03:00:00.000Z', handedOverAt: '2026-10-01T03:10:00.000Z',
    },
  }));
  await json(page, `**/api/bff/core/pos/reports/sales/${saleId}/copies`, () => ({
    body: { saleId, invoiceNumber: 'INV-DMO-2026-000001', terminalCode: 'KSR-01', terminalName: 'Konter 1', cashierUserId: uuid,
      paidAt: '2026-10-01T03:01:00.000Z', copyNumber: 2, isCopy: true, lines: [line], subtotal: '236000.00', taxTotal: '0.00',
      total: '236000.00', cashReceived: '250000.00', changeAmount: '14000.00' },
  }));

  await page.goto('/kantor/penjualan');
  await expect(page.getByRole('cell', { name: 'Selesai' })).toBeVisible();
  await page.getByRole('button', { name: 'INV-DMO-2026-000001' }).click();
  await expect(page.getByText('Kasir Demo · Konter 1')).toBeVisible();
  await expect(page.getByRole('button', { name: /Cetak Salinan/ })).toBeDisabled();
  await page.getByLabel('Alasan').fill('Diminta pelanggan');
  await page.getByRole('button', { name: /Cetak Salinan/ }).click();
  await expect(page.getByRole('article', { name: 'Salinan faktur' })).toContainText('SALINAN');
});

test('a back-office page says so when the account has no access', async ({ page }) => {
  await json(page, '**/api/bff/core/pos/reports/sales?*', () => ({
    status: 403,
    body: { type: '/errors/PERMISSION_DENIED', title: 'Tidak diizinkan', status: 403, detail: 'x', instance: '/x', code: 'PERMISSION_DENIED',
      message: 'Di luar akses Anda.', requestId: 'r', correlationId: 'r', permittedActions: [], retryable: false },
  }));
  await page.goto('/kantor/penjualan');
  await expect(page.getByRole('heading', { name: 'Tidak ada akses' })).toBeVisible();
});
