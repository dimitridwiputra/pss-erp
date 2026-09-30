import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { personPage } from './demo-session';

/**
 * The MVP demo path (MVP_PLAN §1, DEMO_RUNBOOK §4) on the real local stack: Keycloak, the API with
 * PSS_DEMO_POS_ENABLED=true, the web app on :3000 and the seeded demo database. Each person has
 * their own browser context, as separate devices would.
 *
 *   CONFIRM_RESET=yes bash scripts/reset-mvp-demo.sh     # a clean start
 *   pnpm --filter @pss/web test:e2e:mvp
 *
 * Accounting (Codex) and back-office set-up (OpenCode) append their steps here as they land.
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational';
const MI_GORENG = '8990001000012';
let invoiceNumber = '';

async function scan(page: Page, barcode: string) {
  const field = page.getByRole('textbox', { name: 'Scan barang' });
  await field.fill(barcode);
  await field.press('Enter');
  await page.waitForTimeout(650); // past the 500 ms double-read window (POS-003)
}

test('kasir.demo opens a shift, sells two karton for cash, and gets a receipt', async ({ browser }) => {
  const page = await personPage(browser, 'kasir.demo');
  await page.getByRole('link', { name: /Kasir/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Buka Shift' }), 'Reset the demo first: CONFIRM_RESET=yes bash scripts/reset-mvp-demo.sh').toBeVisible();
  await page.getByRole('button', { name: /Konter 1/ }).click();
  await page.getByLabel('Modal laci').fill('500000');
  await page.getByRole('button', { name: 'Buka Shift' }).click();

  await scan(page, MI_GORENG);
  await scan(page, MI_GORENG);
  await expect(page.locator('.pos-total-final')).toContainText('Rp 236.000');
  await page.getByRole('button', { name: /Bayar/ }).click();
  await page.getByLabel('Uang diterima').fill('250000');
  await expect(page.locator('.pos-change')).toContainText('Rp 14.000');
  await page.getByRole('button', { name: /Terima Uang/ }).click();

  const receipt = page.getByRole('article', { name: 'Struk' });
  await expect(receipt).toContainText('Rp 14.000');
  invoiceNumber = (await receipt.locator('p.pos-muted').first().innerText()).split(' · ')[0]!.trim();
  expect(invoiceNumber).toMatch(/^INV-/);
  await page.getByRole('button', { name: /Transaksi Baru/ }).click();
  await page.context().close();
});

test('exception: checkout with more than the stock refuses and leaves the cart as it was', async ({ browser }) => {
  const page = await personPage(browser, 'kasir.demo');
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Scan Barang' })).toBeVisible();
  // A quantity of 999 through the same BFF the screen uses; tapping + 998 times proves nothing more.
  const shift = await (await page.request.get('/api/bff/core/kasir/shift-saya')).json() as { shift: { id: string } };
  const sale = await (await page.request.post('/api/bff/core/pos/sales', { headers: { 'idempotency-key': randomUUID() }, data: { shiftId: shift.shift.id } })).json() as { id: string };
  expect((await page.request.post(`/api/bff/core/pos/sales/${sale.id}/lines`, { headers: { 'idempotency-key': randomUUID() }, data: { barcode: MI_GORENG, qty: '999' } })).status()).toBe(201);
  await page.reload();
  await expect(page.getByText('999 KARTON')).toBeVisible();
  await page.getByRole('button', { name: /Bayar/ }).click();
  await expect(page.locator('.pos-callout-danger')).toContainText('Stok tidak cukup');
  await page.getByRole('button', { name: 'Hapus Mi Goreng 80g' }).click();
  await expect(page.getByText('Keranjang masih kosong')).toBeVisible();
  await page.context().close();
});

test('gudang.demo hands over the goods for the paid receipt', async ({ browser }) => {
  const page = await personPage(browser, 'gudang.demo');
  await page.getByRole('link', { name: /Serah Barang/ }).click();
  await page.getByRole('textbox', { name: 'Scan nomor struk' }).fill(invoiceNumber);
  await page.getByRole('button', { name: 'Cari Struk' }).click();
  await expect(page.getByRole('heading', { name: 'Serahkan Barang' })).toBeVisible();
  await page.getByRole('textbox').last().fill('Budi Santoso');
  await page.getByRole('button', { name: 'Serahkan Barang' }).click();
  await expect(page.getByRole('status')).toContainText(`${invoiceNumber} sudah diserahkan`);
  await page.context().close();
});

test('kasir.demo closes the shift with an exact count and hands over the cash', async ({ browser }) => {
  const page = await personPage(browser, 'kasir.demo');
  await page.goto('/kasir');
  await page.getByRole('button', { name: 'Tutup Shift' }).click();
  await expect(page.getByText('Seharusnya di laci')).toBeVisible();
  await page.getByLabel('Uang di laci setelah dihitung').fill('736000');
  await page.getByRole('button', { name: 'Tutup Shift' }).click();
  await expect(page.getByRole('heading', { name: 'Serah Kas' })).toBeVisible();
  await page.getByRole('button', { name: 'Serahkan Kas' }).click();
  await expect(page.getByRole('heading', { name: 'Kas sudah diserahkan' })).toBeVisible();
  await page.context().close();
});

test('keuangan.demo (with OTP) counts the handover and receives it', async ({ browser }) => {
  const page = await personPage(browser, 'keuangan.demo');
  await page.getByRole('link', { name: /Setoran Kas/ }).click();
  await page.getByRole('button', { name: /Konter 1 · Kasir Demo/ }).first().click();
  await page.getByLabel('Uang yang Anda hitung').fill('236000');
  await page.getByRole('button', { name: /Terima Setoran/ }).click();
  await expect(page.getByRole('status')).toContainText('sudah diterima');
  await page.context().close();
});

test('admin.demo finds the sale in Penjualan and prints a SALINAN', async ({ browser }) => {
  const page = await personPage(browser, 'admin.demo');
  await page.addInitScript(() => { window.print = () => undefined; });
  await page.getByRole('link', { name: /Penjualan Konter/ }).click();
  await page.getByRole('button', { name: invoiceNumber }).click();
  await expect(page.getByText('Barang diambil')).toBeVisible();
  await page.getByLabel('Alasan').fill('Diminta pelanggan');
  await page.getByRole('button', { name: /Cetak Salinan/ }).click();
  await expect(page.getByRole('article', { name: 'Salinan faktur' })).toContainText('SALINAN');
  await page.context().close();
});

test('exception: a sale id from another branch is absent to the back office and refused to a cashier', async ({ browser }) => {
  // A synthetic paid sale in a second branch of the demo organization. Web code may not reach the
  // database (PLT-002), so the fixture is a root script that prints the sale id.
  const saleId = execFileSync('node', [resolve(process.cwd(), '../../scripts/seed-mvp-foreign-branch-sale.mjs')], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl },
  }).trim();

  const admin = await personPage(browser, 'admin.demo');
  const detail = await admin.request.get(`/api/bff/core/pos/reports/sales/${saleId}`);
  expect(detail.status()).toBe(404);
  expect((await detail.json()).code).toBe('NOT_FOUND');
  await admin.goto('/kantor/penjualan');
  await expect(admin.getByRole('table')).toBeVisible();
  await expect(admin.getByText('Konter Cabang Lain')).toHaveCount(0);
  await admin.context().close();

  const kasir = await personPage(browser, 'kasir.demo');
  const line = await kasir.request.post(`/api/bff/core/pos/sales/${saleId}/lines`, { headers: { 'idempotency-key': randomUUID() }, data: { barcode: MI_GORENG } });
  expect(line.status()).toBe(403);
  expect((await line.json()).code).toBe('PERMISSION_DENIED');
  await kasir.context().close();
});

test('kepala.keuangan.demo (with OTP) sees approvals and no counter work', async ({ browser }) => {
  const page = await personPage(browser, 'kepala.keuangan.demo');
  await expect(page.getByRole('link', { name: 'Buka persetujuan' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Kasir|Setoran Kas|Penjualan Konter/ })).toHaveCount(0);
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Tidak ada pekerjaan kasir untuk Anda' })).toBeVisible();
  await page.context().close();
});
