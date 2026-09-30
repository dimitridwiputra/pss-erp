import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect as baseExpect, test, type BrowserContext, type Page } from '@playwright/test';
import { signIn, type DemoUser } from './demo-session';

/**
 * The MVP demo as one continuous video, with Indonesian captions, on the real local stack after a
 * reset (DEMO_RUNBOOK §7). One browser tab records the whole story; switching person clears the
 * context's cookies, which ends both the app and the Keycloak session.
 *
 *   CONFIRM_RESET=yes PSS_DEMO_DATABASE=pss_mvp_e2e bash scripts/reset-mvp-demo.sh
 *   PSS_VIDEO_DIR=/path/to/out pnpm --filter @pss/web exec playwright test -c playwright.e2e.config.ts tests/e2e/demo-video.spec.ts
 */
test.skip(!process.env.PSS_VIDEO_DIR, 'Set PSS_VIDEO_DIR to record the demo video.');
test.setTimeout(30 * 60_000);
// The dev server compiles a route on first visit; give each check room for that.
const expect = baseExpect.configure({ timeout: 45_000 });

const WIDTH = 1440;
const HEIGHT = 900;
const MI_GORENG = '8990001000012';

/** Overlays that survive navigation: a visible cursor, the caption bar, and full-screen cards. */
const overlayScript = `
(() => {
  const css = \`
    #pss-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(234,7,17,.35);border:2px solid #EA0711;pointer-events:none;transition:left .25s ease,top .25s ease,transform .15s;left:-50px;top:-50px}
    #pss-cursor.down{transform:scale(.7);background:rgba(234,7,17,.6)}
    #pss-caption{position:fixed;z-index:2147483646;left:50%;bottom:28px;transform:translateX(-50%);max-width:980px;width:calc(100% - 96px);display:flex;gap:18px;align-items:flex-start;padding:18px 24px;border-radius:16px;background:rgba(4,17,48,.94);color:#fff;font:500 19px/1.45 Inter,system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.35);pointer-events:none;border-left:6px solid #EA0711;opacity:0;transition:opacity .35s}
    #pss-caption.on{opacity:1}
    #pss-caption b{display:block;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#FF8A8F;margin-bottom:2px}
    #pss-card{position:fixed;inset:0;z-index:2147483645;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;background:radial-gradient(circle at 30% 20%,#12357f 0,#041D54 55%,#020c27 100%);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center;opacity:0;transition:opacity .5s;pointer-events:none}
    #pss-card.on{opacity:1}
    #pss-card img{width:150px;height:150px;object-fit:contain;background:#fff;border-radius:28px;padding:14px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    #pss-card .k{font-size:15px;font-weight:800;letter-spacing:.22em;color:#FF8A8F;text-transform:uppercase}
    #pss-card h1{margin:0;font-size:56px;line-height:1.1;letter-spacing:-.03em;max-width:1100px;color:#fff}
    #pss-card p{margin:0;max-width:900px;font-size:22px;line-height:1.5;color:#C9D4EE}
    #pss-card ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:10px;font-size:21px;color:#E6ECFA;text-align:left}
    #pss-card li::before{content:"✓";color:#4ADE80;font-weight:800;margin-right:12px}
    #pss-card.intro img{animation:pss-pop 1.1s cubic-bezier(.2,1.4,.4,1) both}
    #pss-card.intro h1{animation:pss-rise .9s .35s both}
    #pss-card.intro p,#pss-card.intro .k{animation:pss-rise .9s .6s both}
    nextjs-portal{display:none!important}
    @keyframes pss-pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
    @keyframes pss-rise{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
  \`;
  const store = {
    get: () => { try { return sessionStorage.getItem('pss-caption'); } catch { return null; } },
    set: (value) => { try { if (value === null) sessionStorage.removeItem('pss-caption'); else sessionStorage.setItem('pss-caption', value); } catch { /* about:blank has no storage */ } },
  };
  function mount() {
    if (document.getElementById('pss-cursor')) return;
    const style = document.createElement('style'); style.textContent = css; document.documentElement.appendChild(style);
    const cursor = document.createElement('div'); cursor.id = 'pss-cursor'; document.documentElement.appendChild(cursor);
    window.addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', () => cursor.classList.add('down'), true);
    window.addEventListener('mouseup', () => cursor.classList.remove('down'), true);
    const saved = store.get();
    if (saved) window.__pssCaption(JSON.parse(saved), true);
  }
  window.__pssCaption = (caption, instant) => {
    let el = document.getElementById('pss-caption');
    if (!caption) { if (el) el.classList.remove('on'); store.set(null); return; }
    if (!el) { el = document.createElement('div'); el.id = 'pss-caption'; document.documentElement.appendChild(el); }
    el.innerHTML = '<div><b></b><span></span></div>';
    el.querySelector('b').textContent = caption.title;
    el.querySelector('span').textContent = caption.body;
    store.set(JSON.stringify(caption));
    if (instant) el.classList.add('on'); else requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  };
  window.__pssCard = (html, cls) => {
    let el = document.getElementById('pss-card');
    if (!html) { if (el) el.classList.remove('on'); return; }
    if (!el) { el = document.createElement('div'); el.id = 'pss-card'; document.documentElement.appendChild(el); }
    el.className = cls || ''; el.innerHTML = html;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
`;

let logo = '';

async function say(page: Page, title: string, body: string, holdMs = 4200) {
  await page.evaluate((caption) => (window as unknown as { __pssCaption: (c: unknown) => void }).__pssCaption(caption), { title, body });
  await page.waitForTimeout(holdMs);
}

async function hush(page: Page) {
  await page.evaluate(() => (window as unknown as { __pssCaption: (c: unknown) => void }).__pssCaption(null));
}

async function card(page: Page, html: string, holdMs: number, cls = '') {
  await hush(page);
  await page.evaluate(({ h, c }) => (window as unknown as { __pssCard: (h: string, c: string) => void }).__pssCard(h, c), { h: html, c: cls });
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => (window as unknown as { __pssCard: (h: null) => void }).__pssCard(null));
  await page.waitForTimeout(600);
}

async function chapter(page: Page, number: number, title: string, body: string) {
  await card(page, `<img src="${logo}" alt=""><div class="k">Bagian ${number}</div><h1>${title}</h1><p>${body}</p>`, 3600);
}

async function typeSlow(page: Page, locator: ReturnType<Page['getByLabel']>, text: string) {
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(text, { delay: 55 });
}

/** Opens a screen from the sidebar when it is listed there, otherwise by its address. */
async function nav(page: Page, label: string, href: string) {
  const link = page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: label, exact: true }).first();
  // The sidebar's menu arrives from /api/experience/shell after the page; give it a moment.
  const listed = await link.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (listed) await link.click();
  else await page.goto(href);
  await page.waitForURL((url) => url.pathname === href, { timeout: 60_000 });
}

/** Waits until a finance screen has finished loading its figures. */
async function settle(page: Page) {
  // Loading text appears only after hydration: wait briefly for it to show, then for it to go.
  await page.getByText(/sedang dimuat/i).first().waitFor({ state: 'visible', timeout: 4000 }).then(() => undefined, () => undefined);
  await expect(page.getByText(/sedang dimuat/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Memuat…/ })).toHaveCount(0);
  await page.waitForTimeout(800);
}

/** 'operations' (POS, back office, dashboard), 'finance', or both in one video. */
const part = process.env.PSS_VIDEO_PART ?? 'all';

async function switchTo(context: BrowserContext, page: Page, user: DemoUser, who: string) {
  await say(page, 'Ganti pengguna', `Sekarang masuk sebagai ${who}. Setiap orang hanya melihat pekerjaan sesuai hak aksesnya.`, 2600);
  await hush(page);
  await context.clearCookies();
  await signIn(page, user);
  await page.waitForTimeout(900);
}

test('PSS MVP demo video', async ({ browser }) => {
  logo = `data:image/png;base64,${(await readFile(resolve(process.cwd(), 'public/pss-logo.png'))).toString('base64')}`;
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: process.env.PSS_VIDEO_DIR!, size: { width: WIDTH, height: HEIGHT } },
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
  });
  context.setDefaultTimeout(60_000);
  await context.addInitScript(overlayScript);
  await context.addInitScript(() => { window.print = () => undefined; });
  const page = await context.newPage();
  try {
  const sku = `KSGA-${randomUUID().slice(0, 4).toUpperCase()}`;
  const newBarcode = `8990002${String(Date.now()).slice(-6)}`;

  // The intro plays on a blank navy page, so the video never opens on a loading screen.
  await page.goto('about:blank');
  await page.setContent('<html><body style="margin:0;background:#041D54"></body></html>');
  await page.evaluate(overlayScript);
  if (part !== 'finance') {
  // ── Intro ─────────────────────────────────────────────────────────────────────────────────────
  await card(page, `<img src="${logo}" alt=""><div class="k">Putra Sumber Sari</div><h1>PSS Operating Platform</h1><p>Demo MVP: Kasir Konter, Dasbor, dan Keuangan dalam satu platform.</p>`, 5200, 'intro');
  await card(page, `<img src="${logo}" alt=""><h1>Alur yang akan Anda lihat</h1><ul>
    <li>Barang baru, harga jual, dan penerimaan stok dengan harga pokok</li>
    <li>Penjualan tunai di kasir, struk, dan serah barang di gudang</li>
    <li>Tutup shift, serah kas, dan hitung setoran oleh Keuangan</li>
    <li>Laporan penjualan dan salinan faktur</li>
    <li>Jurnal otomatis, persetujuan, laporan keuangan, dan tutup periode</li></ul>`, 7000);

  // ── 1. Satu platform ─────────────────────────────────────────────────────────────────────────
  await chapter(page, 1, 'Satu platform untuk semua peran', 'Masuk dengan akun PSS, lalu setiap orang langsung melihat pekerjaannya.');
  await say(page, 'Masuk yang aman', 'Semua pengguna masuk lewat akun PSS. Peran Keuangan juga wajib memakai kode OTP.', 3200);
  await hush(page);
  await signIn(page, 'admin.demo');
  await page.waitForTimeout(1200);
  await say(page, 'Beranda', 'Beranda menyapa pengguna dan merangkum hari ini: penjualan, transaksi, dan kas yang belum disetor.');
  await say(page, 'Menu sesuai hak akses', 'Menu di kiri dikelompokkan menurut pekerjaan. Menu yang tidak menjadi hak Anda tidak ditampilkan sama sekali.');
  await page.getByRole('main').locator('.home-work').scrollIntoViewIfNeeded().catch(() => undefined);
  await say(page, 'Layar kerja', 'Kartu "Buka layar kerja" membawa Anda langsung ke pekerjaan yang paling sering dipakai.', 3600);
  await page.keyboard.press('Control+k');
  await say(page, 'Cari menu cepat (Ctrl + K)', 'Ketik sebagian nama layar untuk berpindah tanpa mencari di menu.', 1800);
  await page.getByRole('dialog', { name: 'Cari menu' }).getByRole('textbox').pressSequentially('stok', { delay: 90 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Admin/ }).first().click();
  await page.getByRole('menuitemradio', { name: 'Gelap' }).click();
  await say(page, 'Tampilan gelap', 'Pengguna dapat memilih tampilan terang, gelap, atau mengikuti perangkat.', 3600);
  await page.getByRole('menuitemradio', { name: 'Terang' }).click();
  await page.mouse.click(700, 500);
  await hush(page);

  // ── 2. Barang, harga, stok ───────────────────────────────────────────────────────────────────
  await chapter(page, 2, 'Siapkan barang, harga, dan stok', 'Admin kantor menambah barang baru, memberi harga jual, dan menerima stok dengan harga pokok.');
  await page.goto('/kantor');
  await expect(page.getByRole('heading', { name: 'Dasbor Harian' })).toBeVisible();
  await say(page, 'Dasbor Harian', 'Ringkasan kantor: penjualan hari ini, kas konter yang belum dihitung, nilai stok gudang, dan stok yang menipis.', 4600);
  await nav(page, 'Barang', '/kantor/barang');
  await expect(page.getByRole('heading', { name: 'Barang' })).toBeVisible();
  await say(page, 'Data barang', 'Semua barang beserta satuan dan barcodenya ada di satu daftar.', 2600);
  await page.getByRole('button', { name: 'Barang Baru' }).click();
  await typeSlow(page, page.getByLabel('SKU'), sku);
  await typeSlow(page, page.getByLabel('Nama barang'), 'Kopi Susu Gula Aren 250ml');
  await typeSlow(page, page.getByLabel('Satuan dasar'), 'BTL');
  await page.getByLabel('Keadaan').selectOption('ACTIVE');
  await say(page, 'Barang baru', 'Isi SKU, nama, dan satuan dasar. Barang siap dijual setelah diberi harga.', 2400);
  await page.getByRole('button', { name: 'Simpan Barang' }).click();
  await page.getByLabel('Cari SKU atau nama barang').fill(sku);
  await page.getByRole('button', { name: 'Cari', exact: true }).click();
  await page.getByRole('button', { name: 'Kopi Susu Gula Aren 250ml' }).click();
  await expect(page.getByRole('heading', { name: 'Kopi Susu Gula Aren 250ml' })).toBeVisible();
  await typeSlow(page, page.getByRole('textbox', { name: 'Satuan', exact: true }), 'KARTON');
  await typeSlow(page, page.getByLabel('Isi per BTL'), '24');
  await page.getByRole('button', { name: 'Tambah Satuan' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Satuan baru ditambahkan' }).first()).toBeVisible();
  await page.getByLabel('Untuk satuan').selectOption('KARTON');
  await typeSlow(page, page.getByLabel('Kode barcode'), newBarcode);
  await page.getByRole('button', { name: 'Tambah Barcode' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Barcode ditambahkan' }).first()).toBeVisible();
  await say(page, 'Satuan dan barcode', 'Satu karton berisi 24 botol, dan barcode karton dicatat agar kasir cukup memindai.', 3800);

  await nav(page, 'Harga Jual', '/kantor/harga');
  await expect(page.getByRole('button', { name: 'Siapkan Versi Baru' })).toBeEnabled();
  await say(page, 'Harga jual berversi', 'Harga tidak diubah langsung. Admin menyiapkan versi baru, lalu mengaktifkannya sekaligus.', 3200);
  await page.getByRole('button', { name: 'Siapkan Versi Baru' }).click();
  await expect(page.getByRole('button', { name: 'Aktifkan Harga Ini' })).toBeVisible();
  await page.getByRole('button', { name: 'Tambah Harga Barang' }).click();
  await page.getByLabel('Cari barang yang akan diberi harga').fill(sku);
  await page.getByRole('button', { name: 'Cari', exact: true }).last().click();
  await page.getByRole('button', { name: /Kopi Susu Gula Aren/ }).click();
  await page.getByRole('combobox', { name: /^Satuan/ }).selectOption('KARTON');
  await typeSlow(page, page.getByLabel(/Harga jual/), '96000');
  await page.getByRole('button', { name: 'Simpan Harga' }).click();
  await expect(page.getByRole('row', { name: new RegExp(sku) })).toContainText('96.000');
  await page.getByRole('button', { name: 'Aktifkan Harga Ini' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'sudah berlaku' }).first()).toBeVisible();
  await say(page, 'Harga berlaku', 'Rp 96.000 per karton kini berlaku di kasir konter.', 2800);

  await nav(page, 'Terima Barang', '/kantor/terima');
  await expect(page.getByRole('heading', { name: 'Terima Barang' })).toBeVisible();
  await page.getByLabel('Cari barang yang akan diterima').fill(sku);
  await page.getByRole('button', { name: 'Cari', exact: true }).click();
  await page.getByRole('button', { name: /Kopi Susu Gula Aren/ }).click();
  await page.getByLabel(/Satuan untuk/).selectOption('KARTON');
  await typeSlow(page, page.getByLabel(/Jumlah Kopi Susu/), '12');
  await typeSlow(page, page.getByLabel(/Harga pokok Kopi Susu/), '82000');
  await say(page, 'Terima barang dengan harga pokok', 'Barang masuk dicatat bersama harga pokoknya, sehingga nilai stok dan laba kotor dapat dihitung.', 3400);
  await page.getByRole('button', { name: /Terima 1 Baris/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'sudah masuk ke stok gudang' }).first()).toBeVisible();
  await nav(page, 'Stok', '/kantor/stok');
  await expect(page.getByRole('row', { name: new RegExp(sku) })).toContainText('984.000');
  await page.getByRole('row', { name: new RegExp(sku) }).scrollIntoViewIfNeeded();
  await say(page, 'Stok dan nilainya', '12 karton × Rp 82.000 = Rp 984.000. Nilai ini otomatis masuk ke buku besar sebagai persediaan.', 4400);

  // ── 3. Kasir ─────────────────────────────────────────────────────────────────────────────────
  await chapter(page, 3, 'Kasir konter', 'Kasir membuka shift, memindai barang, menerima uang tunai, dan mencetak struk.');
  await switchTo(context, page, 'kasir.demo', 'Kasir Konter');
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Buka Shift' })).toBeVisible();
  await say(page, 'Buka shift', 'Pilih konter dan hitung modal laci sebelum mulai berjualan.', 2800);
  await page.getByRole('button', { name: /Konter 1/ }).click();
  await typeSlow(page, page.getByLabel('Modal laci'), '500000');
  await page.getByRole('button', { name: 'Buka Shift' }).click();
  await expect(page.getByRole('heading', { name: 'Scan Barang' })).toBeVisible();
  await say(page, 'Layar kasir', 'Layar penuh seperti mesin kasir. Pintasan: F2 pindai, F4 cari produk, F9 bayar.', 3600);
  const scanField = page.getByRole('textbox', { name: 'Scan barang' });
  for (const code of [MI_GORENG, MI_GORENG, newBarcode]) {
    await scanField.pressSequentially(code, { delay: 18 });
    await scanField.press('Enter');
    await page.waitForTimeout(900);
  }
  await expect(page.locator('.pos-total-final')).toContainText('Rp 332.000');
  await say(page, 'Pindai barang', 'Pindaian barang yang sama langsung menambah jumlah. Harga diambil dari daftar harga, bukan diketik kasir.', 4200);
  await page.keyboard.press('F9');
  await expect(page.getByRole('heading', { name: 'Terima Uang' })).toBeVisible();
  await say(page, 'Terima uang', 'Pilih nominal cepat atau ketik jumlahnya. Kembalian dihitung otomatis.', 2400);
  const preset = page.locator('.pos-presets').getByRole('button', { name: 'Rp 350.000' });
  if (await preset.count()) await preset.click();
  else await typeSlow(page, page.getByLabel('Uang diterima'), '350000');
  await expect(page.locator('.pos-change')).toContainText('Rp 18.000');
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: /Terima Uang/ }).click();
  const receipt = page.getByRole('article', { name: 'Struk' });
  await expect(receipt).toContainText('Rp 18.000');
  const invoiceNumber = (await receipt.locator('p.pos-muted').first().innerText()).split(' · ')[0]!.trim();
  await say(page, 'Struk dan faktur', `Pembayaran diterima dan faktur ${invoiceNumber} dibuat. Pembeli membawa struk ke gudang untuk mengambil barang.`, 4600);
  await page.getByRole('button', { name: /Transaksi Baru/ }).click();

  // ── 4. Serah barang ──────────────────────────────────────────────────────────────────────────
  await chapter(page, 4, 'Serah barang di gudang', 'Petugas gudang memindai struk dan menyerahkan barang kepada pembeli.');
  await switchTo(context, page, 'gudang.demo', 'Petugas Gudang');
  await page.getByRole('main').getByRole('link', { name: /Serah Barang/ }).click();
  await typeSlow(page, page.getByRole('textbox', { name: 'Scan nomor struk' }), invoiceNumber);
  await page.getByRole('button', { name: 'Cari Struk' }).click();
  await expect(page.getByRole('heading', { name: 'Serahkan Barang' })).toBeVisible();
  await say(page, 'Periksa barang', 'Daftar barang yang sudah dibayar tampil. Petugas mencatat nama penerima.', 3000);
  await typeSlow(page, page.getByRole('textbox').last(), 'Budi Santoso');
  await page.getByRole('button', { name: 'Serahkan Barang' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'sudah diserahkan' }).first()).toBeVisible();
  await say(page, 'Stok berkurang otomatis', 'Saat barang diserahkan, stok berkurang dan harga pokok penjualan tercatat untuk Keuangan.', 4000);

  // ── 5. Tutup shift ───────────────────────────────────────────────────────────────────────────
  await chapter(page, 5, 'Tutup shift dan serah kas', 'Di akhir shift kasir menghitung laci, lalu menyerahkan uang penjualan.');
  await switchTo(context, page, 'kasir.demo', 'Kasir Konter');
  await page.goto('/kasir');
  await page.getByRole('button', { name: 'Tutup Shift' }).click();
  await expect(page.getByText('Seharusnya di laci')).toBeVisible();
  await say(page, 'Hitung laci', 'Sistem menunjukkan uang yang seharusnya ada: modal Rp 500.000 ditambah penjualan tunai Rp 332.000.', 3800);
  await typeSlow(page, page.getByLabel('Uang di laci setelah dihitung'), '832000');
  await page.getByRole('button', { name: 'Tutup Shift' }).click();
  await expect(page.getByRole('heading', { name: 'Serah Kas' })).toBeVisible();
  await say(page, 'Serah kas', 'Uang penjualan diserahkan ke Kasir Keuangan. Modal laci tetap di laci.', 3000);
  await page.getByRole('button', { name: 'Serahkan Kas' }).click();
  await expect(page.getByRole('heading', { name: 'Kas sudah diserahkan' })).toBeVisible();
  await page.waitForTimeout(2200);

  // ── 6. Setoran kas ───────────────────────────────────────────────────────────────────────────
  await chapter(page, 6, 'Setoran kas oleh Keuangan', 'Kasir Keuangan menghitung uang dari kasir. Selisih wajib diberi alasan.');
  await switchTo(context, page, 'keuangan.demo', 'Kasir Keuangan (dengan OTP)');
  await page.getByRole('main').getByRole('link', { name: /Setoran Kas/ }).click();
  await say(page, 'Setoran menunggu dihitung', 'Setoran dari setiap konter menunggu dihitung, lengkap dengan jumlah yang tercatat di sistem.', 3200);
  await page.getByRole('button', { name: /Konter 1 · Kasir Demo/ }).first().click();
  await typeSlow(page, page.getByLabel('Uang yang Anda hitung'), '331000');
  await expect(page.getByText(/Uang kurang/).first()).toBeVisible();
  await say(page, 'Selisih perlu alasan', 'Uang kurang Rp 1.000. Setoran baru bisa diterima setelah alasan dipilih, dan selisihnya dijurnal otomatis.', 4200);
  await page.getByRole('button', { name: 'Uang kurang' }).click();
  await page.getByRole('button', { name: /Terima Setoran/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'sudah diterima' })).toBeVisible();
  await page.waitForTimeout(1800);

  // ── 7. Penjualan & salinan ───────────────────────────────────────────────────────────────────
  await chapter(page, 7, 'Laporan penjualan konter', 'Kantor melihat semua transaksi kasir dan dapat mencetak salinan faktur.');
  await switchTo(context, page, 'admin.demo', 'Admin Kantor');
  await page.goto('/kantor/penjualan');
  await expect(page.getByRole('table')).toBeVisible();
  await say(page, 'Penjualan Konter', 'Saring per tanggal, kasir, atau shift. Status tiap transaksi ditulis dengan bahasa kerja.', 3800);
  await page.getByRole('button', { name: invoiceNumber }).click();
  await expect(page.getByText('Barang diambil')).toBeVisible();
  await say(page, 'Rincian transaksi', 'Siapa kasirnya, kapan dibayar, dan kapan barang diambil, dalam satu layar.', 3000);
  await typeSlow(page, page.getByLabel('Alasan'), 'Diminta pelanggan');
  await page.getByRole('button', { name: /Cetak Salinan/ }).click();
  await expect(page.getByRole('article', { name: 'Salinan faktur' })).toContainText('SALINAN');
  await say(page, 'Salinan faktur', 'Salinan selalu bertanda SALINAN dan dicatat bersama alasannya untuk jejak audit.', 3600);

  }

  if (part === 'finance') {
    await card(page, `<img src="${logo}" alt=""><div class="k">Putra Sumber Sari</div><h1>PSS Operating Platform</h1><p>Demo MVP bagian 2: Keuangan otomatis, persetujuan, dan tutup periode.</p>`, 5200, 'intro');
  }
  if (part !== 'operations') {
  // ── 8. Keuangan otomatis ─────────────────────────────────────────────────────────────────────
  await chapter(page, 8, 'Keuangan otomatis', 'Setiap kejadian operasional menjadi jurnal yang seimbang tanpa input ulang.');
  await switchTo(context, page, 'keuangan.demo', 'Staf Keuangan (dengan OTP)');
  await page.goto('/keuangan'); await settle(page);
  await expect(page.getByRole('heading', { name: 'Beranda Keuangan' })).toBeVisible();
  await say(page, 'Beranda Keuangan', 'Ringkasan keuangan dan pekerjaan yang perlu ditindaklanjuti.', 3200);
  await page.goto('/keuangan/jurnal'); await settle(page);
  await expect(page.getByRole('heading', { name: 'Jurnal' })).toBeVisible();
  await page.waitForTimeout(800);
  await say(page, 'Jurnal otomatis', 'Penerimaan stok, pembayaran, faktur, harga pokok, dan selisih kas sudah menjadi jurnal otomatis.', 4600);
  await page.goto('/keuangan/laba-rugi'); await settle(page);
  await expect(page.getByRole('heading', { name: 'Laba Rugi' })).toBeVisible();
  await say(page, 'Laba Rugi', 'Pendapatan dikurangi harga pokok penjualan menghasilkan laba kotor periode berjalan.', 4200);
  await page.goto('/keuangan/jurnal-manual');
  await say(page, 'Jurnal manual', 'Untuk transaksi tanpa dokumen operasional, Keuangan membuat jurnal manual yang harus disetujui orang lain.', 3600);
  await typeSlow(page, page.getByLabel('Tujuan dan alasan'), 'Beban administrasi demo');
  const rows = page.locator('.finance-form-row');
  await rows.nth(0).getByLabel('Akun').selectOption('6-9000');
  await rows.nth(0).getByLabel('Debit').fill('1000.00');
  await rows.nth(1).getByLabel('Akun').selectOption('1-1100');
  await rows.nth(1).getByLabel('Kredit').fill('1000.00');
  await expect(page.getByRole('status').filter({ hasText: 'Seimbang' }).filter({ hasNotText: 'Belum' })).toBeVisible();
  await say(page, 'Debit sama dengan kredit', 'Jurnal hanya bisa disimpan bila seimbang.', 2600);
  await page.getByRole('button', { name: 'Simpan draf' }).click();
  const draftLink = page.getByRole('link', { name: 'Tinjau draf jurnal' });
  await expect(draftLink).toBeVisible();
  const journalId = (await draftLink.getAttribute('href'))?.split('/').pop();
  await page.getByRole('button', { name: 'Ajukan persetujuan' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'menunggu persetujuan' })).toBeVisible();
  await say(page, 'Diajukan', 'Pembuat jurnal tidak dapat menyetujui jurnalnya sendiri.', 3000);

  // ── 9. Persetujuan & tutup periode ───────────────────────────────────────────────────────────
  await chapter(page, 9, 'Persetujuan dan tutup periode', 'Kepala Keuangan menyetujui jurnal, meninjau neraca saldo, lalu menutup periode.');
  await switchTo(context, page, 'kepala.keuangan.demo', 'Kepala Keuangan (dengan OTP)');
  await say(page, 'Tanpa pekerjaan kasir', 'Kepala Keuangan tidak melihat menu kasir. Tindakan berikutnya adalah persetujuan.', 3200);
  await expect.poll(async () => {
    await page.goto('/persetujuan');
    return page.getByTestId('approval-card').filter({ hasText: journalId! }).count();
  }, { timeout: 60_000 }).toBe(1);
  const approval = page.getByTestId('approval-card').filter({ hasText: journalId! });
  await approval.scrollIntoViewIfNeeded();
  await say(page, 'Kotak persetujuan', 'Semua permintaan yang menjadi wewenangnya ada di satu tempat.', 2600);
  await typeSlow(page, approval.getByLabel('Alasan keputusan'), 'Beban demo dan jurnal seimbang');
  await approval.getByRole('button', { name: 'Setujui' }).click();
  await expect(page).toHaveURL(/result=done/);
  await say(page, 'Disetujui', 'Keputusan dicatat bersama alasannya, lalu jurnal dibukukan otomatis.', 3000);
  // Posting follows the approval asynchronously; the trial balance shows it once it lands.
  await expect.poll(async () => {
    await page.goto('/keuangan/neraca-saldo'); await settle(page);
    return page.getByRole('row').filter({ hasText: /Beban Lain-lain.*1\.000/ }).count();
  }, { timeout: 90_000, intervals: [3000] }).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Neraca Saldo' })).toBeVisible();
  await say(page, 'Neraca Saldo', 'Jurnal yang disetujui langsung dibukukan. Total debit dan kredit selalu sama.', 4400);
  await page.goto('/keuangan/neraca'); await settle(page);
  await expect(page.getByRole('heading', { name: 'Neraca' })).toBeVisible();
  await say(page, 'Neraca', 'Aset, kewajiban, dan ekuitas, termasuk laba periode berjalan.', 3600);
  await page.goto('/keuangan/periode'); await settle(page);
  await page.getByRole('button', { name: 'Tutup sementara' }).click();
  await typeSlow(page, page.getByLabel('Alasan tindakan'), 'Rekonsiliasi demo selesai');
  await page.getByRole('dialog').getByRole('button', { name: 'Tutup sementara' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ditutup sementara' })).toBeVisible();
  await say(page, 'Tutup periode', 'Periode ditutup sementara agar tidak ada posting baru, lalu penutupan akhir diajukan untuk disetujui.', 4200);

  }

  // ── Outro ────────────────────────────────────────────────────────────────────────────────────
  await card(page, `<img src="${logo}" alt=""><h1>Satu alur, dari konter sampai laporan keuangan</h1><ul>
    <li>Kasir cepat dengan pindai barcode dan pintasan keyboard</li>
    <li>Stok, harga pokok, dan kas tercatat otomatis</li>
    <li>Jurnal otomatis yang seimbang, dengan persetujuan berlapis</li>
    <li>Setiap orang hanya melihat pekerjaan sesuai perannya</li></ul>`, 7000);
  await card(page, `<img src="${logo}" alt=""><div class="k">Putra Sumber Sari</div><h1>PSS Operating Platform</h1><p>Terima kasih.</p>`, 4200, 'intro');

  } finally {
    // Closing the context is what finalises the video file, so it happens even after a failed step.
    await context.close();
  }
});
