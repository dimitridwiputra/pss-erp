# MVP demo runbook: PSS Kasir, Back Office, Accounting

Status: **Draft (30 September).** The counter, Penjualan and Setoran Kas sections were walked on the real API. The accounting commands and screens are wired; the complete real-stack Finance browser path still needs rehearsal. Back-office setup remains with OpenCode. Rehearse from this file on the demo laptop on Day 9 (MVP_PLAN §2).

This is a demo build. It activates no branch, real cash or real books (MVP_PLAN §9–§10).

## 1. Before the day

- Docker Desktop, Node (see `scripts/check-toolchain.mjs`), pnpm, and a Chromium-based browser.
- `pnpm install` in the repository.
- An authenticator app on the presenter's phone. `keuangan.demo` and `kepala.keuangan.demo` must use one: their roles are `mfaRequired` (Appendix D), and approval decisions check a login less than 15 minutes old.
  - The demo-path test (§7) enrols both and records each secret, with an `otpauth://` link, in `.local/pss-mvp-demo-otp.txt` (gitignored).
  - Add those two secrets to the phone, typed in or from the link, so the phone and the test share one authenticator.
  - If a user enrolled another device instead, the test stops and says so.
- The demo passwords are in `.local/pss-mvp-demo-logins.txt` in the main checkout (gitignored). They are never pasted into slides or chat.
- If Postgres restarts during the demo, the API keeps running and reconnects on the next request. No restart is needed.

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

`pnpm dev:up` also starts `apps/finance-api` on port 4001 and the integration worker on port 4002. If starting them separately, use two terminals from the repository root with the same database as the core API:

```bash
DATABASE_URL=postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational \
  PSS_OIDC_ISSUER=http://127.0.0.1:8080/realms/pss-local \
  PSS_OIDC_AUDIENCE=pss-api \
  PSS_OIDC_JWKS_URI=http://127.0.0.1:8080/realms/pss-local/protocol/openid-connect/certs \
  pnpm --filter @pss/finance-api dev
```

```bash
DATABASE_URL=postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational \
  REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @pss/integration-worker dev
```

After a reset, `scripts/reset-mvp-demo.sh` seeds the demo chart of accounts, posting rules, the current period, and the Controller journal-approval route in Platform's existing approval policy. Check `http://127.0.0.1:4001/health/ready` and `http://127.0.0.1:4002/health/ready` before selling.

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
| Products | 20 items in 5 categories, each with a base unit, a case unit, a barcode, a KONTER price and a unit cost. Opening stock is 50 per unit for the first four (below) and one case's worth for the rest. |
| The four the demo names | Mi Goreng 80g (KARTON, Rp118.000, cost Rp95.000, barcode 8990001000012, 50 in stock); Air Mineral 600ml (KARTON, Rp48.000, 8990001000029); Minuman Cokelat 200ml (KARTON, Rp126.000, 8990001000036); Saus Sambal 340ml (BTL, Rp12.000, 8990001000043) |
| The rest | DEMO-005…DEMO-020: four more mie, five minuman, four bumbu, three snack, one kebutuhan rumah |

Every row goes through the domain's own commands — `createProduct`, `addProductUom`, `addProductBarcode`, `activatePriceList`, `receiveStock` — so the demo's catalogue is a validated, audited, versioned write rather than a fixture insert. The receipt carries a unit cost, so opening stock is worth Rp 40.732.000 on the first day and the first sale has a cost of goods sold to measure a margin against.

Prices, costs and pack sizes are placeholders, not PSS data (MVP-OD-6).

**PPN** (MVP-OD-3) is per customer. Every demo product is taxable and the seed configures a demo rate (`PSS_DEMO_PPN_RATE`, default 11%), so whether a sale carries PPN is the customer's switch on **Pelanggan**. The walk-in customer *Pelanggan Umum Grosir* starts with PPN **off**, which keeps every amount in §4 as written. To rehearse with PPN, seed with `PSS_DEMO_WALK_IN_PPN=on`, or switch it on screen (§4.1).

## 4. Demo script

Each role signs in at `http://localhost:3000/masuk`. **Switching user needs two sign-outs:** `Keluar` on `/beranda`, then open `http://127.0.0.1:8080/realms/pss-local/protocol/openid-connect/logout` and press **Logout**. Otherwise Keycloak signs the previous user straight back in. Using one browser profile per role avoids this.

### 4.1 Back office sets up (admin.demo)

Sign in as `admin.demo` and open **Kantor** from the sidebar on `/beranda`. Every screen below is in that sidebar, grouped by work: *Hari Ini* (Beranda, Persetujuan, Dasbor Harian), *Penjualan*, *Persediaan* (Stok, Terima Barang, Penyesuaian Stok) and *Data Utama* (Barang, Harga Jual, Pelanggan). **Cari menu…** (Ctrl/⌘ K) jumps to any of them.

The three stock screens carry a **Gudang** control in their own heading, not in the frame, because a product or a price has no warehouse. It lists only the warehouses the signed-in user may act on, and with none in scope the screen says so instead of showing a number. The sidebar itself is the one frame shared with POS and Finance (`docs/mvp/UI_SHELL.md`), so nothing here draws its own.

**Barang — a product, its units, its barcodes (MDM-001..003).**

1. **Barang** → **Barang Baru**. SKU `BRG-001`, name *Teh Kotak 350ml*, base unit `BTL`, **Dicatat di**: PSS, **Keadaan**: Aktif. **Simpan Barang**.
2. A SKU cannot be edited afterwards; the product page says so. Open it, set the name to *Teh Kotak 350ml*, and press **Simpan Perubahan** — a second person editing the same product gets *data sudah berubah*, not a silent overwrite.
3. Under **Satuan dan barcode**: **Tambah satuan** `KARTON`, isi per `BTL` = `24`. The factor is written once and never edited.
4. **Tambah barcode**: unit `KARTON`, code `8990002000018`. The form asks which *unit* the label is for, because a case label is not a piece label.
5. **The exception to show here:** open *Mi Goreng 80g* and try the same `8990002000018`. The server refuses — *"Barcode 8990002000018 sudah dipakai barang lain"* — and the product keeps `8990001000012`.

**Harga — a price change is a new version (COM-001).**

6. **Harga Jual** → **Siapkan Versi Baru**. The draft copies every price that is in force, so only what changed needs retyping. The version is *Belum aktif*: the counter is still selling at the old list.
7. **Tambah Harga Barang** → search `BRG-001` → pick it → **Harga jual** `12000` → **Simpan Harga**. Pick one existing price and press **Ubah** to move it by a few rupiah, so the version is visibly different.
8. **Aktifkan Harga Ini.** The new list takes over at the counter; the old one becomes *Kedaluwarsa*. There is no approval step in the MVP (MVP-OD-14) — say so.

**Terima Barang — the receipt, with a cost (WMS-003).**

9. **Terima Barang** → search `BRG-001` → pick it. The line is added with the base unit; the unit dropdown offers the product's own units only.
10. Quantity `10`, **Harga pokok** `9800`. Press **Terima 1 Baris**. The confirmation names the movement and says the goods are in stock.
11. **To show the unvalued path:** receive a second line with the cost left empty. The screen says *"1 baris tanpa harga pokok — nilainya belum dihitung dan perlu dilengkapi Finance"*, and `INVENTORY_RECEIVED` is published with `unitCost: null` so Finance gets an exception rather than a zero cost. Leave `Teh Kotak 350ml` costed for the demo proper.

**Stok — the shelf and its value (INV-001, INV-002).**

12. **Stok** → *Saldo* lists every balance in the warehouse with its moving-average cost and value. The total is at the top; a balance that has never been valued reads *belum ada harga pokok*, never Rp 0.
13. Press **Riwayat** for the movement ledger: *Penerimaan*, *Pengeluaran*, *Penyesuaian*, with the cost and the value of each movement.

**Penyesuaian Stok — a correction, with a reason (INV-004).**

14. **Penyesuaian Stok** → search `BRG-001` → pick it. Type `-2` in **Selisih** (a shortage), and pick a reason from the list — the options are the domain's own active codes with their Indonesian labels, never free text. A zero is refused: correcting nothing is a mistake.
15. Press **Simpan 1 Koreksi**. There is no approval step in the demo (`inventory.adjustment.approve` belongs to `BRANCH_MANAGER`, which no demo user holds), so say that the correction is final.

**Pelanggan** lists the customers (MDM-004) and has one switch per customer: **Kena PPN** / **Tanpa PPN**. The branch's walk-in customer is marked *Pelanggan sistem cabang*; its switch decides PPN for every walk-in counter sale made afterwards. Switching it on mid-demo changes the next sale, never one already checked out: Mi Goreng KARTON then costs Rp118.000 + PPN Rp12.980 = **Rp130.980**, the counter and the struk show a *PPN* line, and Finance posts the PPN to *PPN Keluaran* (2-1300). Switch it back to **Tanpa PPN** before §4.2 if you want the runbook's amounts.

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
3. **Serah Kas** says what to hand over; the float stays in the drawer. After a short count it shows the real amount beside the recorded sales (MVP-OD-29). Press **Serahkan Kas**.

### 4.5 Finance counts the cash (keuangan.demo)

1. Sign in with OTP, then open **Setoran Kas**. The handover waits in *Menunggu dihitung*, with the cashier, counter, recorded amount and the cashier's close count.
2. Tap it and type the counted amount. If it differs, pick a reason (**Uang kurang** and so on). **Terima Setoran** stays disabled until one is chosen (MVP-OD-26).
3. Press **Terima Setoran** (CASH_CUSTODY_VERIFIED, journal Dr Kas Kantor / Cr Kas Konter ± Selisih Kas).
4. Show that the cashier cannot verify their own cash: the server refuses (SOD-06).

### 4.6 Sales review (admin.demo)

1. **Penjualan Konter** lists the day's sales. Tap a cashier or a counter to filter.
2. Open a sale for its lines, payment and pickup times. **Cetak Salinan** with a reason prints a copy marked SALINAN.

### 4.7 Accounting (keuangan.demo, kepala.keuangan.demo)

1. Sign in as `keuangan.demo` with OTP. From `/beranda`, open **Keuangan**. **Beranda Keuangan** shows the period, posting exceptions, recent journals, and today's and month-to-date gross profit from posted Finance figures.
2. Open **Jurnal**. Find the payment, invoice and cash-verification journals from sections 4.2–4.5. Open one to see its debit and credit lines and source document. If inventory has no cost yet, open **Pengecualian Posting** and show its visible unvalued-movement exception; do not call that a zero-value posting.
3. Open **Jurnal Manual**. Enter today's business date and the reason `Beban administrasi demo`. On the first row choose **6-9000 Beban Lain-lain**, debit `1000.00`. On the second choose **1-1100 Kas Kantor**, credit `1000.00`. Check the **Seimbang** indicator, press **Simpan draf**, then **Ajukan persetujuan**. Accounts for receivables and inventory are control accounts and cannot be used in this free-form flow.
4. Sign in separately as `kepala.keuangan.demo` with OTP less than 15 minutes old. Open **Persetujuan**, find the card for that journal number, enter a review reason and press **Setujui**. The worker returns the decision to Finance, which posts the journal. Refresh **Jurnal** and check that its status is **Dibukukan**.
5. Open **Neraca Saldo** and find **Beban Lain-lain** with the additional Rp1.000 debit. Open **Laba Rugi**, **Neraca**, and **Buku Besar** to show the posted figures and the Kas Kantor journal line. These reports read posted Finance journals.
6. Open **Periode** as the Controller. Choose **Tutup sementara**, enter a reason, and confirm. Refresh, choose **Tutup periode**, enter a reason, and submit. The final close waits for a separate `finance.close.approve` actor; none of the five demo users has that grant (MVP-OD-30). Show the pending request, not a CLOSED period.

### 4.8 Dashboard (admin.demo)

Open **Dasbor Harian** — under *Hari Ini* in the sidebar, and a tile on `/beranda`. Five tiles, and the point of the screen is that **each one answers for itself**: a tile that cannot be read says so in words under a dash, and the other four keep their numbers. Nothing is ever shown as Rp 0 to cover a failed read.

| Tile | What it says | Where it comes from |
|---|---|---|
| Penjualan hari ini | The day's counter sales and how many transactions | `GET /api/bff/core/pos/reports/summary` (`pos.report.view`) |
| Kas konter belum dihitung | Counter cash Finance has not yet counted, and how many payments are waiting | the same read — it is one domain's answer, so the two tiles stand or fall together |
| Laba kotor hari ini | Today's gross profit, with the month to date under it | Finance (MVP-OD-31) — **not built yet**, so this tile reads *Belum tersedia*. Say so; do not read it as a zero margin |
| Nilai stok gudang | The warehouse's inventory value, and how many goods have no cost yet | `GET /api/bff/core/inventory/stock-balances` |
| Stok menipis | How many goods are below the threshold, with the five lowest listed | the same read, filtered by `maxQty` |

Below the tiles, **Perlu diisi ulang** lists the low-stock goods with their remaining quantity and a link to **Terima Barang**, so the dashboard ends in an action rather than a number.

`/beranda` itself carries a **Gudang** widget for a viewer who may open the stock screen: the warehouse's value, the count of goods running out, and the same five rows — so the operator does not have to enter the back office to know the shelf is short before the day starts.

The threshold is not a constant: the BFF supplies `PSS_DASHBOARD_LOW_STOCK_MIN_QTY` (default 10) as an input to the query, and the tile shows the threshold it used (MVP-OD-17). The warehouse comes from the signed-in user's own WAREHOUSE-scoped grants, not from configuration — nobody sees another branch's stock.

Press **Muat Ulang** (the tiles also refresh every minute) after the cashier's sale to watch Penjualan hari ini and Kas konter belum dihitung move.

## 5. Exception paths to show

- **Insufficient stock:** scan a product and raise its quantity above what is in stock (the seed has 50), then press **Bayar**. "Stok tidak cukup" appears, the sale stays in the cart, and nothing is reserved.
- **Duplicate barcode:** in Barang, add a barcode that another product already has. "Kode sudah dipakai" appears with the sentence that names the code, and the first product keeps its own label. The automated path covers this.
- **Unknown barcode:** scan `0000000000000`. "Barang tidak ditemukan" appears.
- **Wrong branch or another cashier's sale:** covered by `apps/api/tests/pos.integration.test.ts` (another organization's id is reported as absent, and another cashier's shift is refused). Show the test output rather than forge a request in the demo.
- **Retry does not charge twice:** covered by the same test. Each command's Idempotency-Key replays the first answer.

## 6. Known limitations (say them openly)

MVP_PLAN §9: no QRIS, transfer, credit (tempo) sales, returns, purchase orders and AP invoices, tax/e-Faktur, multiple branches, ND6/FoxPro integration, offline sync, hosted deployment, fixed assets or bank reconciliation.

From stream A:
- The receipt carries the invoice number. `KSR-{CAB}-…` receipt numbering waits for the numbering template (GAP-16), and the branch code in the number is a placeholder derived from the branch id.
- PPN is a per-customer switch with a demo rate. PKP status, the statutory rate and DPP rule, and price-inclusive pricing are not decided (MVP-OD-3), so do not present the PPN amount as PSS's real tax position.
- Only units with a counter price can be sold. The demo prices each product in one unit, so the katalog offers one unit per product.
- One product in two units (KARTON and PCS) can't be paid in one sale yet (MVP-OD-28). The counter says so and asks to split the sale.
- A handover counted differently without a reason stays "Perlu keputusan selisih": the CSH-002 approval is not built (MVP-OD-26).
- No customer selection, order list or returns on the counter.
- Offline mode is not in the demo. The counter says so when the connection drops.

From stream C (back office):
- **The dashboard's gross-profit tile has no source.** `apps/finance-api` publishes only `/health`, so *Laba kotor hari ini* reads *Belum tersedia* and says the accounting report is the missing piece (MVP-OD-31). It is never shown as Rp 0, which would read as "no profit".
- **A price change needs no approval.** COM-001 requires one and rejects proposer = approver; the MVP activates a draft directly and audits the activation (MVP-OD-14).
- **A stock correction needs no approval either.** `inventory.adjustment.approve` belongs to `BRANCH_MANAGER`, which no demo user holds, so a correction posted from Penyesuaian Stok is final.
- **A goods receipt may leave stock unvalued.** Leaving the cost empty is a real state (a physical count has no invoice), and the movement is published with `unitCost: null` for Finance to resolve. There is no revaluation, so a later valued receipt does not value a balance that already holds unvalued stock (MVP-OD-16).
- **Two read permissions are still gaps, recorded not hidden.** The Stok screens use `inventory.stock_card.view`, the permission INV-001 names, since Identity registered it on 30 September. No registered code exists for reading a product or a customer, so Barang and Pelanggan stand on the steward write grant the demo role holds (MVP-OD-20, MVP-OD-21).
- **A warehouse id cannot be fully validated.** A warehouse nobody has ever stocked is accepted, because no domain exposes a warehouse-by-id read yet (MVP-OD-22).
- **The low-stock threshold is not configuration.** It is an input to the query, supplied by the BFF as `PSS_DASHBOARD_LOW_STOCK_MIN_QTY` (default 10) and shown beside the number (MVP-OD-17).

## 7. The demo path, automated

`apps/web/tests/e2e/mvp-demo-path.spec.ts` runs sections 4.1–4.7 on the real stack: five people in separate browser sessions, OTP included, plus both exception paths from §5.
- **Back office:** `admin.demo` creates a product, adds a case unit and a barcode on it, is refused a duplicate barcode, prices the case in a new version of the list, activates it, receives twelve cases at a cost, finds the balance with its value, and reads the dashboard — including the gross-profit tile degrading rather than showing zero.
- **Finance:** the step ends with a period-close request pending the separate approver (MVP-OD-30).
- **Insufficient stock:** refused, and the cart is left as it was.
- **A sale id from another branch:** absent in Penjualan, refused to a cashier.

Run it after a reset, with the API and web running:

```bash
CONFIRM_RESET=yes bash scripts/reset-mvp-demo.sh
```

```bash
pnpm --filter @pss/web test:e2e:mvp
```

To keep your working data, run it against its own database instead. Point both the reset and the API at `pss_mvp_e2e`:

```bash
CONFIRM_RESET=yes PSS_DEMO_DATABASE=pss_mvp_e2e bash scripts/reset-mvp-demo.sh
```

```bash
DATABASE_URL=postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_mvp_e2e bash scripts/dev-mvp-api.sh
```

```bash
DATABASE_URL=postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_mvp_e2e pnpm --filter @pss/web test:e2e:mvp
```

Its first runs found and fixed four things the mocked tests could not:
- Two scans of one product crashed checkout. Repeats now merge into one line.
- Scans made while the previous one was still on the network were lost. They now queue.
- A database restart killed the API. The pool now survives it.
- A full `pnpm build` during a reset broke the running web app. The reset now builds only what the seed needs.

Codex and OpenCode append their steps to this spec.

### 7.1 Recording the demo video

`apps/web/tests/e2e/demo-video.spec.ts` records the whole story as one video with Indonesian captions: the PSS logo intro, nine chapters (platform, back office, kasir, serah barang, tutup shift, setoran kas, penjualan, keuangan, persetujuan and tutup periode) and an outro. It needs all three streams merged, the API, finance-api and integration worker running, and a fresh reset.

- **Run the web app as a production build** (`pnpm --filter @pss/web build`, then `pnpm --filter @pss/web start`). Under `next dev`, first-visit compiles on a busy machine stalled the recording.
- **Reset first, then wait for the web to settle.** The reset rewrites `apps/web/.env.local`, which restarts `next dev`.
- **Rebuild every workspace `dist`** after a merge (at least contracts, platform, reporting and finance). The worker loads them, and a stale `@pss/reporting` rejected `APPROVAL_DECIDED` v2, so an approved journal never posted.

```bash
PSS_VIDEO_DIR=/path/to/out pnpm --filter @pss/web exec playwright test -c playwright.e2e.config.ts tests/e2e/demo-video.spec.ts
```

`PSS_VIDEO_PART=operations` or `finance` records half the story. The output is a 1440×900 WebM. It opens in Chrome or VLC; QuickTime needs an MP4 conversion.

## 8. If something is down

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
