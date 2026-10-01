import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { personPage } from './demo-session';
import { snapshot } from './shell.fixture';

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

test('admin.demo sets up a new product, prices it, and receives it with a cost', async ({ browser }) => {
  const page = await personPage(browser, 'admin.demo');
  const sku = `DEMO-E2E-${randomUUID().slice(0, 8)}`;
  const barcode = `8990002${randomUUID().replace(/\D/g, '').slice(0, 6)}`;

  // The /kantor shell is one sidebar for every back-office screen, including the two that were written
  // before it existed and used to draw their own frame.
  await page.goto('/kantor');
  await expect(page.getByRole('heading', { name: 'Dasbor Harian' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Barang', exact: true }).click();
  // Generous, because this is the first request for this route and the dev server compiles it on
  // demand. The screen itself answers in well under a second once compiled.
  await expect(page.getByRole('heading', { name: 'Barang' })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Barang Baru' }).click();
  await page.getByRole('textbox', { name: 'SKU' }).fill(sku);
  await page.getByRole('textbox', { name: 'Nama barang' }).fill('Kopi Susu Gula Aren 250ml');
  await page.getByRole('textbox', { name: 'Satuan dasar' }).fill('BTL');
  await page.getByRole('combobox', { name: 'Keadaan' }).selectOption('ACTIVE');
  await page.getByRole('button', { name: 'Simpan Barang' }).click();
  // The list is paged, so the new product is found by its SKU rather than by being on page one.
  await page.getByRole('textbox', { name: 'Cari SKU atau nama barang' }).fill(sku);
  await page.getByRole('button', { name: 'Cari', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(sku) })).toBeVisible();

  await page.getByRole('button', { name: 'Kopi Susu Gula Aren 250ml' }).click();
  await expect(page.getByRole('heading', { name: 'Kopi Susu Gula Aren 250ml' })).toBeVisible({ timeout: 20_000 });

  // A case unit, then a barcode on that unit: a case label is not a piece label (MDM-003).
  await page.getByRole('textbox', { name: 'Satuan', exact: true }).fill('KARTON');
  await page.getByRole('textbox', { name: /Isi per BTL/ }).fill('24');
  await page.getByRole('button', { name: 'Tambah Satuan' }).click();
  await expect(page.getByText('Satuan baru ditambahkan.')).toBeVisible();
  await page.getByRole('combobox', { name: /Untuk satuan/ }).selectOption('KARTON');
  await page.getByRole('textbox', { name: 'Kode barcode' }).fill(barcode);
  await page.getByRole('button', { name: 'Tambah Barcode' }).click();
  await expect(page.getByText('Barcode ditambahkan.')).toBeVisible();
  await expect(page.getByRole('cell', { name: barcode })).toBeVisible();

  // The exception this step is also there to prove: the same barcode on another product is refused
  // with the server's own words, and the first product keeps the code.
  await page.getByRole('button', { name: 'Kembali ke daftar' }).click();
  await page.getByLabel('Cari SKU atau nama barang').fill('DEMO-001');
  await page.getByRole('button', { name: 'Cari', exact: true }).click();
  await page.getByRole('button', { name: 'Mi Goreng 80g' }).click();
  await page.getByRole('combobox', { name: /Untuk satuan/ }).selectOption('KARTON');
  await page.getByRole('textbox', { name: 'Kode barcode' }).fill(barcode);
  await page.getByRole('button', { name: 'Tambah Barcode' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Kode sudah dipakai' })).toContainText('sudah dipakai barang lain');
  await expect(page.getByRole('cell', { name: '8990001000012' })).toBeVisible();
  await page.getByRole('button', { name: 'Kembali ke daftar' }).click();

  // A price is a new version of the list, never an edit: prepare a draft, price the new goods, activate.
  await page.getByRole('link', { name: 'Harga Jual' }).click();
  await expect(page.getByRole('heading', { name: 'Harga Jual' })).toBeVisible({ timeout: 20_000 });
  // The button is disabled until the live list has loaded, so a draft always starts as its copy.
  await expect(page.getByRole('button', { name: 'Siapkan Versi Baru' })).toBeEnabled();
  await page.getByRole('button', { name: 'Siapkan Versi Baru' }).click();
  await expect(page.getByRole('button', { name: 'Aktifkan Harga Ini' })).toBeVisible();
  await page.getByRole('button', { name: 'Tambah Harga Barang' }).click();
  const pricePicker = page.getByRole('region', { name: 'Tambah harga barang' });
  await pricePicker.getByRole('textbox').fill(sku);
  await pricePicker.getByRole('button', { name: 'Cari', exact: true }).click();
  await page.getByRole('button', { name: /Kopi Susu Gula Aren/ }).click();
  // Priced in KARTON, because that is the unit whose barcode was just printed. A price in the base unit
  // would leave the counter with a label it cannot price, and the sale would be refused at checkout.
  await page.getByRole('combobox', { name: /^Satuan/ }).selectOption('KARTON');
  await page.getByLabel(/Harga jual/).fill('96000');
  await page.getByRole('button', { name: 'Simpan Harga' }).click();
  await expect(page.getByRole('row', { name: new RegExp(sku) })).toContainText('96.000');
  const activate = page.getByRole('button', { name: 'Aktifkan Harga Ini' });
  await expect(activate).toBeEnabled();
  await activate.click();
  await expect(page.getByText(/sudah berlaku di konter/)).toBeVisible();

  // The receipt, with a cost: the shelf is worth something and the first sale has a margin to measure.
  await page.getByRole('link', { name: 'Terima Barang' }).click();
  await expect(page.getByRole('heading', { name: 'Terima Barang' })).toBeVisible({ timeout: 20_000 });
  const receivePicker = page.getByRole('region', { name: 'Daftar terima' });
  await receivePicker.getByRole('textbox').fill(sku);
  await receivePicker.getByRole('button', { name: 'Cari', exact: true }).click();
  await page.getByRole('button', { name: /Kopi Susu Gula Aren/ }).click();
  // Received in the case unit, not the base one: the unit on a receipt is the operator's choice, and
  // the balance then carries that unit — which is what makes the demo's "one product, two units" real.
  await page.getByRole('combobox', { name: /Satuan untuk/ }).selectOption('KARTON');
  await page.getByRole('textbox', { name: /Jumlah Kopi Susu/ }).fill('12');
  await page.getByRole('textbox', { name: /Harga pokok Kopi Susu/ }).fill('82000');
  await page.getByRole('button', { name: /Terima 1 Baris/ }).click();
  await expect(page.getByText(/sudah masuk ke stok gudang/)).toBeVisible();
  // A costed receipt is complete, so the screen must not warn that a line is unvalued.
  await expect(page.getByText(/tanpa harga pokok/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Stok', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stok' })).toBeVisible({ timeout: 20_000 });
  const row = page.getByRole('row', { name: new RegExp(sku) });
  await expect(row).toContainText('KARTON');
  await expect(row).toContainText('12');
  await expect(row).toContainText('82.000');
  await expect(row).toContainText('984.000');

  // The dashboard: the tiles that have a source carry numbers, and the one that does not yet says so
  // in words rather than showing a zero (MVP-OD-31).
  await page.getByRole('link', { name: 'Dasbor Harian' }).click();
  const card = (label: string) => page.locator('.pss-kpi-card').filter({ hasText: label });
  await expect(card('Penjualan hari ini')).toContainText('Rp', { timeout: 20_000 });
  await expect(card('Kas konter belum dihitung')).toContainText('Rp');
  await expect(card('Nilai stok gudang')).toContainText('Rp');
  // The gross-profit tile has no source yet and says so in words. It must never render Rp 0, which
  // would read as "no profit" (MVP-OD-31). Which words it uses depends on whether the accounting
  // service is running at all, so the step asserts the property, not the wording: a reason, and no
  // rupiah amount.
  await expect(card('Laba kotor hari ini')).not.toContainText('Rp');
  await expect(card('Laba kotor hari ini')).toContainText(/belum tersedia|Keuangan/);
  // The threshold travels with the low-stock count, so the number is never a mystery (MVP-OD-17).
  await expect(page.getByRole('region', { name: 'Perlu diisi ulang' })).toContainText('di bawah 10 per satuan');

  await page.context().close();
});

test('kasir.demo opens a shift, sells two karton for cash, and gets a receipt', async ({ browser }) => {
  const page = await personPage(browser, 'kasir.demo');
  await page.getByRole('main').getByRole('link', { name: /Kasir/ }).first().click();
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
  await page.getByRole('main').getByRole('link', { name: /Serah Barang/ }).click();
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
  await page.getByRole('main').getByRole('link', { name: /Setoran Kas/ }).click();
  await page.getByRole('button', { name: /Konter 1 · Kasir Demo/ }).first().click();
  await page.getByLabel('Uang yang Anda hitung').fill('236000');
  await page.getByRole('button', { name: /Terima Setoran/ }).click();
  await expect(page.getByRole('status')).toContainText('sudah diterima');
  await page.context().close();
});

test('admin.demo finds the sale in Penjualan and prints a SALINAN', async ({ browser }) => {
  const page = await personPage(browser, 'admin.demo');
  await page.addInitScript(() => { window.print = () => undefined; });
  await page.getByRole('main').getByRole('link', { name: /Penjualan Konter/ }).click();
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
  await expect(page.getByRole('main').getByRole('link', { name: 'Buka persetujuan' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /Kasir|Setoran Kas|Penjualan Konter/ })).toHaveCount(0);
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Tidak ada pekerjaan kasir untuk Anda' })).toBeVisible();
  await page.context().close();
});

test('Finance maker submits a journal, the checker posts it, and requests period close', async ({ browser }) => {
  const maker = await personPage(browser, 'keuangan.demo');
  await maker.goto('/keuangan/jurnal-manual');
  await maker.getByLabel('Tujuan dan alasan').fill('Beban administrasi demo');
  const rows = maker.locator('.finance-form-row');
  await rows.nth(0).getByLabel('Akun').selectOption('6-9000');
  await rows.nth(0).getByLabel('Debit').fill('1000.00');
  await rows.nth(1).getByLabel('Akun').selectOption('1-1100');
  await rows.nth(1).getByLabel('Kredit').fill('1000.00');
  await expect(maker.getByRole('status').filter({ hasText: 'Seimbang' })).toBeVisible();
  await maker.getByRole('button', { name: 'Simpan draf' }).click();
  const draftLink = maker.getByRole('link', { name: 'Tinjau draf jurnal' });
  await expect(draftLink).toBeVisible();
  const journalId = (await draftLink.getAttribute('href'))?.split('/').pop();
  expect(journalId).toBeTruthy();
  const journal = await (await maker.request.get(`/api/bff/finance/finance/journals/${journalId}`)).json() as { number: string };
  await maker.getByRole('button', { name: 'Ajukan persetujuan' }).click();
  await expect(maker.getByRole('status').filter({ hasText: 'menunggu persetujuan' })).toBeVisible();
  await maker.context().close();

  const checker = await personPage(browser, 'kepala.keuangan.demo');
  await expect.poll(async () => {
    await checker.goto('/persetujuan');
    return checker.getByTestId('approval-card').filter({ hasText: `Jurnal ${journal.number}` }).count();
  }, { timeout: 30_000 }).toBe(1);
  const card = checker.getByTestId('approval-card').filter({ hasText: `Jurnal ${journal.number}` });
  await card.getByLabel('Alasan keputusan').fill('Beban demo dan jurnal seimbang');
  await card.getByRole('button', { name: 'Setujui' }).click();
  await expect.poll(async () => {
    const response = await checker.request.get(`/api/bff/finance/finance/journals/${journalId}`);
    return response.ok() ? ((await response.json()) as { status: string }).status : 'WAITING';
  }, { timeout: 30_000 }).toBe('POSTED');
  await checker.goto('/keuangan/neraca-saldo');
  await expect(checker.getByRole('heading', { name: 'Neraca Saldo' })).toBeVisible();
  await expect(checker.getByRole('row').filter({ hasText: 'Beban Lain-lain' })).toContainText('Rp\u00a01.000');
  await checker.locator('.pss-app-account-button').click();
  await checker.getByRole('menuitemradio', { name: 'Gelap' }).click();
  await expect(checker.locator('html')).toHaveAttribute('data-theme', 'dark');
  await snapshot(checker, 'keuangan-neraca-saldo-dark');
  await checker.goto('/keuangan/neraca');
  await expect(checker.getByRole('heading', { name: 'Neraca', exact: true })).toBeVisible();
  await expect(checker.getByRole('table')).toBeVisible();
  await expect(checker.locator('html')).toHaveAttribute('data-theme', 'dark');
  await snapshot(checker, 'keuangan-neraca-dark');

  await checker.goto('/keuangan/periode');
  await checker.getByRole('button', { name: 'Tutup sementara' }).click();
  await checker.getByLabel('Alasan tindakan').fill('Rekonsiliasi demo selesai');
  await checker.getByRole('dialog').getByRole('button', { name: 'Tutup sementara' }).click();
  await expect(checker.getByRole('status').filter({ hasText: 'ditutup sementara' })).toBeVisible();
  await checker.reload();
  await checker.getByRole('button', { name: 'Tutup periode' }).click();
  await checker.getByLabel('Alasan tindakan').fill('Ajukan tutup buku demo');
  await checker.getByRole('dialog').getByRole('button', { name: 'Ajukan tutup periode' }).click();
  await expect(checker.getByRole('status').filter({ hasText: 'menunggu persetujuan' })).toBeVisible();
  await checker.context().close();
});
