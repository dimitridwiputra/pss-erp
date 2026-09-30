# MVP demo runbook: PSS Kasir, Back Office, Accounting

Status: **Draft (stream A, 30 September).** The counter, Penjualan and Setoran Kas sections were walked on the real API. The back-office (OpenCode) and accounting (Codex) sections are placeholders for those streams to fill before the Day 8 freeze. Rehearse from this file on the demo laptop on Day 9 (MVP_PLAN §2).

This is a demo build. It activates no branch, real cash or real books (MVP_PLAN §9–§10).

## 1. Before the day

- Docker Desktop, Node (see `scripts/check-toolchain.mjs`), pnpm, and a Chromium-based browser.
- `pnpm install` in the repository.
- An authenticator app on the presenter's phone. `keuangan.demo` and `kepala.keuangan.demo` enrol one on first login: their roles are `mfaRequired` (Appendix D), and approval decisions check a login less than 15 minutes old. Enrol both during rehearsal, not in front of the audience.
- The demo passwords are in `.local/pss-mvp-demo-logins.txt` in the main checkout (gitignored). They are never pasted into slides or chat.

## 2. Start

```bash
PSS_DEMO_POS_ENABLED=true pnpm dev:up
```

`dev:up` does four things:
- starts PostgreSQL, Redis, MinIO and Keycloak;
- applies every pending migration (`pnpm db:migrate`);
- creates the demo identities;
- starts the app shells.

The switch it is given reaches the API, whose POS routes answer only with it on, and never under `NODE_ENV=production` (MVP-OD-5).

To restart only the API (for example after a reset), stop its terminal and run:

```bash
bash scripts/dev-mvp-api.sh
```

Codex's `apps/finance-api` and the finance consumers: *(Codex to add the start command.)*

Check that the API is up and the switch is on:

```bash
curl -s http://127.0.0.1:4000/kasir/shift-saya
```

`UNAUTHENTICATED` means ready. `FEATURE_DISABLED` means the API was started without `PSS_DEMO_POS_ENABLED=true`.

## 3. Reset and seed

Before each rehearsal and on the morning of the demo:

```bash
CONFIRM_RESET=yes bash scripts/reset-mvp-demo.sh
```

This drops and rebuilds the local `pss_operational` database. It applies every migration, recreates the five demo users' PSS accounts and roles (Keycloak users and passwords are kept), and seeds the synthetic data (MVP-OD-6):

| Seeded | Values |
|---|---|
| Counters | Konter 1 (KSR-01), Konter 2 (KSR-02) in Gudang Demo |
| Products (KONTER price, 50 in stock each) | Mi Goreng 80g (KARTON, Rp118.000, barcode 8990001000012); Air Mineral 600ml (KARTON, Rp48.000, 8990001000029); Minuman Cokelat 200ml (KARTON, Rp126.000, 8990001000036); Saus Sambal 340ml (BTL, Rp12.000, 8990001000043) |

Prices and pack sizes are placeholders, not PSS data. Stock is received unvalued until OpenCode's costing merges. *(OpenCode: switch the seed to the product, price and goods-receipt commands, with a unit cost, once they exist.)*

## 4. Demo script

Each role signs in at `http://localhost:3000/masuk`. **Switching user needs two sign-outs:** `Keluar` on `/beranda`, then open `http://127.0.0.1:8080/realms/pss-local/protocol/openid-connect/logout` and press **Logout**. Otherwise Keycloak signs the previous user straight back in. Using one browser profile per role avoids this.

### 4.1 Back office sets up (admin.demo, gudang.demo) — *OpenCode to fill*

Create a product with its barcode and price, then receive goods with a unit cost (INVENTORY_RECEIVED, journal Dr Persediaan / Cr Barang Diterima Belum Ditagih). Until then, use the seeded products.

### 4.2 Cashier sells (kasir.demo)

1. Sign in, then on `/beranda` open **Kasir**.
2. **Buka Shift:** choose **Konter 1**, type `500000` in *Modal laci*, then press **Buka Shift**.
3. **Scan:** type or scan `8990001000012` and press Enter, twice, more than half a second apart. Each scan adds a line; a double-read within 500 ms counts once (POS-003). Scan `8990001000043`. Use **+** or **−** to change a quantity.
4. Press **Bayar**. This is one transaction: stock is reserved, and the sales order, delivery order and invoice are created.
5. **Terima Uang:** press **Rp 300.000**. The change (Kembalian) shows; the button stays disabled while the cash is short. Press **Terima Uang** (PAYMENT_RECEIVED, journal Dr Kas Konter / Cr Piutang Usaha).
6. **Struk** shows the lines, cash, change and "Tunjukkan struk ini di gudang". Press **Cetak Struk**. **Cetak Ulang** asks for a reason and prints "SALINAN".
7. Press **Transaksi Baru**.

### 4.3 Warehouse hands over (gudang.demo, a different person: SOD-09)

1. Sign in, then open **Serah Barang**. The paid sale waits in *Menunggu Diambil*.
2. Scan or type the struk number (e.g. `INV-…-000001`), or tap the row.
3. Type the receiver's name, then press **Serahkan Barang**. This is one transaction: the delivery is confirmed, stock is issued, and the invoice is issued (INVOICE_ISSUED, journal Dr Piutang Usaha / Cr Penjualan; INVENTORY_ISSUED, Dr HPP / Cr Persediaan once costing lands).

### 4.4 Cashier closes (kasir.demo)

1. **Tutup Shift** (only with an empty cart) shows *Modal laci*, *Penjualan tunai* and *Seharusnya di laci*.
2. Type the counted cash. To show a variance, type Rp1.000 less, then choose **Uang kurang**. Press **Tutup Shift**.
3. **Serah Kas** says what to hand over; the float stays in the drawer. After a short count it shows the real amount beside the recorded sales (MVP-OD-11). Press **Serahkan Kas**.

### 4.5 Finance counts the cash (keuangan.demo)

1. Sign in with OTP, then open **Setoran Kas**. The handover waits in *Menunggu dihitung*, with the cashier, counter, recorded amount and the cashier's close count.
2. Tap it and type the counted amount. If it differs, pick a reason (**Uang kurang** and so on). **Terima Setoran** stays disabled until one is chosen (MVP-OD-9).
3. Press **Terima Setoran** (CASH_CUSTODY_VERIFIED, journal Dr Kas Kantor / Cr Kas Konter ± Selisih Kas).
4. Show that the cashier cannot verify their own cash: the server refuses (SOD-06).

### 4.6 Sales review (admin.demo)

1. **Penjualan Konter** lists the day's sales. Tap a cashier or a counter to filter.
2. Open a sale for its lines, payment and pickup times. **Cetak Salinan** with a reason prints a copy marked SALINAN.

### 4.7 Accounting (keuangan.demo, kepala.keuangan.demo) — *Codex to fill*

Manual journal (maker), approval and posting (checker, a different user), Neraca Saldo / Laba Rugi / Neraca / Buku Besar, and period close.

### 4.8 Dashboard — *OpenCode to fill*

Today's sales and "kas belum disetor" come from `GET /api/bff/core/pos/reports/summary`.

## 5. Exception paths to show

- **Insufficient stock:** scan a product and raise its quantity above what is in stock (the seed has 50), then press **Bayar**. "Stok tidak cukup" appears, the sale stays in the cart, and nothing is reserved.
- **Unknown barcode:** scan `0000000000000`. "Barang tidak ditemukan" appears.
- **Wrong branch or another cashier's sale:** covered by `apps/api/tests/pos.integration.test.ts` (another organization's id is reported as absent, and another cashier's shift is refused). Show the test output rather than forge a request in the demo.
- **Retry does not charge twice:** covered by the same test. Each command's Idempotency-Key replays the first answer.

## 6. Known limitations (say them openly)

MVP_PLAN §9: no QRIS, transfer, credit (tempo) sales, returns, purchase orders and AP invoices, tax/e-Faktur, multiple branches, ND6/FoxPro integration, offline sync, hosted deployment, fixed assets or bank reconciliation.

From stream A:
- The receipt carries the invoice number. `KSR-{CAB}-…` receipt numbering waits for the numbering template (GAP-16), and the branch code in the number is a placeholder derived from the branch id.
- PPN is 0 on every invoice until PKP status and rate are decided (MVP-OD-3).
- The catalog search lists products, but adding one is by barcode until master-data offers a product-by-id query (MVP-OD-10).
- A handover counted differently without a reason stays "Perlu keputusan selisih": the CSH-002 approval is not built (MVP-OD-9).
- No customer selection, order list or returns on the counter.
- Offline mode is not in the demo. The counter says so when the connection drops.

## 7. If something is down

| Symptom | Likely cause | Fix |
|---|---|---|
| Every POS screen says "Fitur belum aktif" | The API runs without the switch, or with `NODE_ENV=production` | Stop the API and run `bash scripts/dev-mvp-api.sh` |
| "Silakan masuk" right after signing in | Web session lost (web restarted, or a new `AUTH_SECRET`) | Sign in again |
| Sign-in page does not load | Keycloak is down | `docker compose up -d keycloak`, wait about 30 s |
| "Koneksi terputus" or "Dependensi tidak tersedia" | API or Postgres is down | `docker compose up -d postgres`, then restart the API |
| Scanning types into the field but nothing is added | The scanner does not send Enter | Press **Tambah**, or set the scanner to send Enter |
| Data from an earlier rehearsal is in the way | Not reset | `CONFIRM_RESET=yes bash scripts/reset-mvp-demo.sh` |

**Last-resort fallback:** walk the flow in the Playwright run instead of live. It drives every screen against a stand-in API in about 20 seconds:

```bash
pnpm --filter @pss/web exec playwright test -c playwright.ci.config.ts tests/e2e/kasir-counter.spec.ts tests/e2e/kantor-counter.spec.ts --headed
```

Show `pnpm test:integration` output for the backend guarantees.
