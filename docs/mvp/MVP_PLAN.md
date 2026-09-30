# MVP plan — PSS Kasir + Back Office + Accounting (demo build)

Status: **Active plan, 1–13 October 2026 (9 working days).** Demo build only. Nothing in this plan activates a branch, real cash, or real books. Every business value marked **DEMO DEFAULT** is a placeholder that Finance/Product must approve before production use (AGENTS.md §20: surface, do not invent).

This file is the shared source of truth for the three parallel agents. If a change touches this file's contracts, the agent that owns the section updates it and notes the change in its daily report.

## 1. The demo story (one connected loop)

```text
Back office: create product + barcode + price → receive goods with unit cost
  → stock up, INVENTORY_RECEIVED → journal Dr Persediaan / Cr Barang Diterima Belum Ditagih
Cashier (PSS Kasir): open shift → scan → Bayar → Terima Uang (TUNAI)
  → PAYMENT_RECEIVED → journal Dr Kas Konter / Cr Piutang Usaha
Warehouse staff: serah barang (pickup handover, a different user — SOD-09)
  → INVENTORY_ISSUED → journal Dr HPP / Cr Persediaan
  → INVOICE_ISSUED   → journal Dr Piutang Usaha / Cr Penjualan (/ Cr PPN Keluaran)
Cashier: tutup shift → serah kas
Finance cashier: verifikasi setoran → CASH_CUSTODY_VERIFIED → journal Dr Kas Kantor / Cr Kas Konter (± Selisih Kas)
Finance: jurnal manual (maker) → approve (checker) → post; Neraca Saldo, Laba Rugi, Neraca, Buku Besar; tutup periode
Dashboard: today's sales, cash not yet deposited, low stock, gross profit
```

## 2. Timeline and checkpoints

| Day | Date | Checkpoint (all three agents) |
|---|---|---|
| 1 | Thu 1 Oct | **Contract freeze.** Claude merges event payload schemas (§5), BFF proxy, demo roles, demo switch. Codex merges the demo accounting defaults decision record. OpenCode merges the costing migration. |
| 3 | Mon 5 Oct | **Events flow.** A POS sale and a goods receipt write outbox events that pass `parseEventForPublication`. |
| 5 | Wed 7 Oct | **Full chain.** Root integration test: receipt → sale → handover → cash verification produces balanced journals; trial balance ties. |
| 7 | Fri 9 Oct | **Feature complete.** All screens connected to real endpoints. |
| 8 | Mon 12 Oct | **Code freeze.** Bug fixes only; Playwright demo path green. |
| 9 | Tue 13 Oct | **Rehearsal** on the demo laptop using `docs/mvp/DEMO_RUNBOOK.md`. |

## 3. Branching and merge rules

- Precondition: the owner commits the current `feat/config-write-path-and-audit-retention` work, then creates `mvp/integration` from it. All agent branches start from `mvp/integration`.
- Branches, each in its own git worktree: `mvp/foundation-pos` (Claude), `mvp/finance` (Codex), `mvp/backoffice` (OpenCode).
- Merge into `mvp/integration` **at the end of every day**, in the order Claude → OpenCode → Codex. Each agent rebases on `mvp/integration` at the start of every day.
- A merge requires green results from `pnpm lint && pnpm typecheck && pnpm architecture:check && pnpm contracts:check && pnpm db:check && pnpm test && pnpm test:integration`.
- Commits end with the attribution line the owner's tooling requires. No force-pushes to `mvp/integration`.

## 4. Ownership (who may edit what)

| Area | Owner | Others may |
|---|---|---|
| `domains/pos`, `domains/invoicing`, `domains/payments`, `domains/orders`, `domains/fulfillment`, `domains/identity` | **Claude** | call exported functions only |
| `packages/contracts/src/events/index.ts` (payload schemas + `eventSchemaRegistry`) | **Claude** | request a change through this file; never edit |
| Web BFF proxy (`apps/web/lib/bff/*`), `/kasir`, `/pos-preview`, `/kantor/penjualan`, `/kantor/setoran-kas`, `/beranda` tiles | **Claude** | use the proxy |
| `domains/master-data`, `domains/commercial`, `domains/inventory` (including costing and inventory events) | **OpenCode** | call exported functions only |
| `/kantor/*` except `penjualan` and `setoran-kas`; `/kantor` dashboard | **OpenCode** | — |
| `domains/finance`, `apps/finance-api`, finance consumers in `apps/integration-worker`, `/keuangan/*` | **Codex** | call finance-api only |
| `domains/wms`, `/gudang` | nobody (frozen) | OpenCode may make the one change §6.3 requires |

**Shared hotspots, append-only one-line edits allowed by anyone:** `packages/contracts/src/api/index.ts` (one `export *` line per new file), `apps/api/src/main.ts` controller list, `scripts/check-api-controller-registration.mjs` allow-list, `vitest.integration.config.ts` include list, `scripts/apply-migrations.mjs` domain list. Put new API contracts in a new file per area (`api/backoffice-*.ts`, `api/finance-*.ts`, `api/pos-*.ts`). Resolve conflicts in these files by keeping both sides.

## 5. Event contracts (v1): Claude implements on Day 1, everyone builds against them now

Envelope: the existing canonical envelope (`EventEnvelopeSchema`, `producer` required, `organizationId` in the envelope). Money is a decimal string with 2 places (`"118000.00"`), quantity a decimal string with 3 places, an inventory `unitCost` a decimal string with 4 places (the ledger's `numeric(18,4)`; `totalCost` stays 2-place money and is what Finance posts), `businessDate` is `YYYY-MM-DD` in Asia/Jakarta. All payloads use `z.strictObject`. Events are appended through `appendOutboxEvent` **in the same transaction** as the fact they describe.

| Event | Producer / aggregate | Payload |
|---|---|---|
| `INVENTORY_RECEIVED` | inventory / InventoryMovement | `movementId, warehouseId, productId, uom, qty, unitCost \| null, totalCost \| null, sourceType: 'GOODS_RECEIPT' \| 'WMS_RECEIPT', sourceId, businessDate` |
| `INVENTORY_ISSUED` | inventory / InventoryMovement | `movementId, warehouseId, productId, uom, qty, unitCost \| null, totalCost \| null, sourceType: 'SALES_FULFILLMENT', sourceId, businessDate` |
| `INVENTORY_ADJUSTED` | inventory / StockAdjustment | `adjustmentId, warehouseId, productId, uom, qtyDelta (signed), unitCost \| null, totalCostDelta \| null (signed), reasonCode, businessDate` |
| `INVOICE_ISSUED` | invoicing / Invoice | `invoiceId, invoiceNumber, customerId, branchId, salesOrderId, channel: 'POS', currency: 'IDR', subtotal, taxAmount, total, businessDate` |
| `PAYMENT_RECEIVED` | payments / Payment | `paymentId, method: 'TUNAI', amount, currency: 'IDR', customerId, referenceType: 'POS_SALE', referenceId, invoiceId \| null, receivedBy, cashLocationType: 'POS_SHIFT', cashLocationId, businessDate` |
| `CASH_CUSTODY_VERIFIED` | payments / CashCustodyRecord | `cashCustodyRecordId, declaredAmount, countedAmount, varianceAmount (counted − declared, signed), verifiedBy, sourceType: 'POS_SHIFT', sourceId, businessDate` |
| `PAYMENT_REVERSED` | payments / Payment | `paymentId, originalEventId, reasonCode, businessDate`; the Payments owner emits this only after its authoritative reversal workflow. Finance requires the original posting and an active compensation rule (MVP-OD-9). |
| `JOURNAL_POSTED` | finance / Journal | `journalId, journalNumber, periodCode, businessDate, sourceType, sourceEventId \| null, totalDebit, totalCredit` |
| `JOURNAL_REVERSED` | finance / Journal | `journalId, reversalJournalId, reasonCode` |
| `ACCOUNTING_PERIOD_CLOSED` | finance / AccountingPeriod | `periodId, periodCode, closedBy` |
| `FINANCE_APPROVAL_SUBMITTED` | finance / FinanceApprovalEffect | `requestId, type, ownerDomain, subjectType, subjectRef, subjectVersion, requestedBy, scopeType, scopeId, contextHash`; Platform processes it through its inbox (MVP-OD-8). |
| `APPROVAL_DECIDED` v2 | approval / ApprovalRequest | `requestId, type, subjectType, subjectRef, subjectVersion, ownerDomain, decision, decidedBy, reason?, step`; Finance verifies correlation and version before applying its effect (MVP-OD-8). |
| `ACCOUNTING_PERIOD_REOPENED` | finance / AccountingPeriod | `periodId, periodCode, reopenedBy, approvalRequestId, reason` after Platform decision (MVP-OD-8/9). |

A `null` cost means the movement is **unvalued** (for example a WMS receipt without a cost). Finance must route it to the exception queue rather than post zero or skip it (AGENTS.md §3.7).

## 6. Scope per stream

### 6.1 Claude — foundation, POS, sales and cash
Fix `tests/integration/pos-checkout-flow.integration.test.ts`; demo seed; server-side demo switch `PSS_DEMO_POS_ENABLED`; harden and register `PosController`; web BFF proxy for `apps/api` and `apps/finance-api`; demo roles; POS UI (`/pos-preview` design wired to the real API, counter flow only); invoicing/payments event emission; list/detail endpoints and screens for **Penjualan** and **Setoran Kas**; root full-chain integration test; Playwright demo path; `DEMO_RUNBOOK.md`.

### 6.2 Codex — accounting (`domains/finance`, `apps/finance-api`, `/keuangan`)
Chart of accounts, accounting periods, journals (automatic and manual), versioned posting rules, event consumers, maker-checker via the existing approval inbox, reversal, period close/reopen, reports (Buku Besar, Neraca Saldo, Laba Rugi, Neraca), subledger reconciliation, finance UI.

### 6.3 OpenCode — back office (`master-data`, `commercial`, `inventory`, `/kantor`)
Create/update product, barcode and UoM; list/search customers; set and activate prices; moving-average costing on inventory; inventory events; goods receipt with unit cost; stock adjustment with reason; stock balance/movement queries; back-office screens; dashboard. The one permitted WMS change: pass `unitCost: null` explicitly where WMS calls `receiveStock`.

## 7. Demo roles (Claude maps on Day 1; permission codes from PRD Appendix D)

| Demo user | Role | Does | Appendix D role @ scope | Permission codes the demo uses |
|---|---|---|---|---|
| `kasir.demo` | Kasir | POS shift, sale, tender, close, cash handover | `POS_CASHIER` @ WAREHOUSE | `pos.shift.open`, `pos.sale.create`, `pos.sale.checkout`, `pos.tender.accept`, `pos.shift.close`, `pos.receipt.reprint`, `payments.cash_handover.declare` (MVP-OD-24) |
| `gudang.demo` | Staf Gudang | pickup handover, goods receipt | `WAREHOUSE_ADMIN` @ WAREHOUSE | `fulfillment.pickup.handover`, `procurement.receipt.post` |
| `admin.demo` | Admin Back Office | products, prices, stock adjustment, Penjualan (list, detail, invoice copy), dashboard | `MASTER_DATA_STEWARD` @ ORG, `COMMERCIAL_ADMIN` @ ORG, `WAREHOUSE_ADMIN` @ WAREHOUSE, `POS_SUPERVISOR` @ WAREHOUSE, `SALES_ADMIN` @ BRANCH | `master_data.product.manage` (MVP-OD-25); `commercial.price_list.manage`; `inventory.adjustment.request`; `pos.report.view`; `invoicing.invoice.print` |
| `keuangan.demo` | Staf Keuangan (maker) | verify cash deposit, create manual journal | `CASHIER` @ BRANCH, `FINANCE_MAKER` @ ORG | `payments.cash_custody.verify`, `finance.journal.create`, `finance.journal.submit` |
| `kepala.keuangan.demo` | Kepala Keuangan (checker) | approve/post manual journal, close period | `CONTROLLER` @ ORG | `finance.journal.approve`, `finance.close.manage` |

Mapping notes (Claude, Day 1):

- The mapping lives in `domains/identity/src/domain/role-permissions.ts` and the seed in `infrastructure/keycloak/pss-demo-users.json`, which also fixes the demo organization, branch and warehouse IDs every stream's seed must use. `domains/identity/tests/demo-roles.test.ts` proves each row above is granted in the demo scope, denied elsewhere, and free of SOD-07/08.
- Check the permission code in the table, never a role code (RBAC-001.R02). Anything not in the table is not granted to any demo user.
- OpenCode: guard product create/update with `master_data.product.manage`.
- Who uses Penjualan was decided on 30 Sep by the owner: `admin.demo`, with `POS_SUPERVISOR` for `pos.report.view` (POS-015) and `SALES_ADMIN` for the invoice copy (`invoicing.invoice.print`, BIL-001). The receipt reprint stays with the cashier (`pos.receipt.reprint`).
- OpenCode's `/kantor` dashboard reads `GET /api/bff/core/pos/reports/summary?date=YYYY-MM-DD` (`PosDashboardSummaryResponseSchema` in `packages/contracts/src/api/pos-sales-report.ts`): today's POS sales total and count, and counter cash not yet counted by Finance. It needs `pos.report.view`, which `admin.demo` holds.
- The `/beranda` work tiles are listed in `apps/web/lib/experience/home-view.ts`. To add a tile for `/kantor` or `/keuangan` once that route exists, ask Claude or add one line there (append-only).
- `inventory.adjustment.approve` belongs to `BRANCH_MANAGER`, which no demo user holds. If an adjustment needs approval, OpenCode raises it here first.
- `CASHIER`, `FINANCE_MAKER` and `CONTROLLER` are `mfaRequired` in Appendix D, and approval decisions call `requireRecentMfa` (TOTP within 15 minutes). The seed meets that control rather than skipping it: `keuangan.demo` and `kepala.keuangan.demo` carry Keycloak's `CONFIGURE_TOTP` required action, so each enrols an authenticator app on first login. For the demo, log in as `kepala.keuangan.demo` shortly before approving; a refreshed token does not extend the step-up window.
- `CONTROLLER` also holds `GL-MAKE`. Maker-checker is still per journal (a different user must approve), so this is Appendix D's own grant and does not weaken §4.5.

Test credentials are generated by `scripts/setup-local-identity.mjs` into `.local/pss-mvp-demo-logins.txt` (gitignored) and are never committed, pasted into chat, or written in docs.

## 8. DEMO DEFAULT accounting policy (Codex records it as a decision; Finance must sign off)

Chart of accounts (IDR, one organization, one branch):

| Code | Account | Type |
|---|---|---|
| 1-1100 | Kas Kantor | Asset |
| 1-1110 | Kas Konter | Asset |
| 1-1300 | Piutang Usaha | Asset |
| 1-1400 | Persediaan Barang Dagang | Asset |
| 2-1150 | Barang Diterima Belum Ditagih | Liability |
| 2-1300 | PPN Keluaran | Liability |
| 3-1000 | Modal | Equity |
| 3-2000 | Laba Ditahan | Equity |
| 4-1000 | Penjualan | Revenue |
| 5-1000 | Harga Pokok Penjualan | Expense |
| 6-2100 | Selisih Persediaan | Expense |
| 6-2200 | Selisih Kas | Expense |
| 6-9000 | Beban Lain-lain | Expense |

Posting rules v1:

| Event | Debit | Credit |
|---|---|---|
| `INVENTORY_RECEIVED` (valued) | 1-1400 totalCost | 2-1150 totalCost |
| `INVENTORY_ISSUED` (valued) | 5-1000 totalCost | 1-1400 totalCost |
| `INVENTORY_ADJUSTED` loss / gain | 6-2100 / 1-1400 | 1-1400 / 6-2100 |
| `INVOICE_ISSUED` | 1-1300 total | 4-1000 subtotal; 2-1300 taxAmount (when > 0) |
| `PAYMENT_RECEIVED` (TUNAI) | 1-1110 amount | 1-1300 amount |
| `CASH_CUSTODY_VERIFIED` | 1-1100 countedAmount; 6-2200 shortage | 1-1110 declaredAmount; 6-2200 overage |

Other defaults: calendar-month periods in Asia/Jakarta; moving-average cost per warehouse, product and UoM; PPN posted only from the invoice's own `taxAmount` (the current POS invoice has tax 0, so PPN Keluaran stays unused until Finance confirms PKP status, rate and price-inclusive rules); manual journals need a different approver (AGENTS.md §4.5). Payment is posted before the invoice in the POS flow, so Piutang Usaha carries a temporary credit balance between payment and handover. This is expected and must be shown correctly in the reconciliation.

## 9. Out of scope (say so openly in the demo)

QRIS, transfer, credit (tempo) sales, returns, purchase orders and AP invoices, tax/e-Faktur, multiple branches, ND6/FoxPro integration, offline sync, hosted deployment, fixed assets, bank reconciliation.

## 10. Decision registry (open items use demo defaults; production blocked until sign-off)

| ID | Decision | Default | Owner |
|---|---|---|---|
| MVP-OD-1 | Chart of accounts | §8 table | Finance |
| MVP-OD-2 | Posting rules | §8 table | Finance |
| MVP-OD-3 | PPN status, rate, price-inclusive | Tax from the invoice only (currently 0) | Finance/Tax |
| MVP-OD-4 | Costing method | Moving average | Finance |
| MVP-OD-5 | POS API demo exposure | Server-side `PSS_DEMO_POS_ENABLED`, off by default, refused in production | Engineering owner |
| MVP-OD-6 | Demo data | Synthetic sample products | Product owner |
| MVP-OD-7 | **DECIDED:** Control-account roles and manual posting | `AR_CONTROL`, `AP_CONTROL`, `GRNI`, `INVENTORY`, `INVENTORY_IN_TRANSIT`, `INVENTORY_IN_TRANSFER`, financially valued `INVENTORY_QUARANTINE`, `UNAPPLIED_RECEIPTS`, `CUSTOMER_DEPOSITS`, `CASH_IN_TRANSIT`: `manual_posting_policy=DENY`. Use `AccountRoleMapping`; opening balances use MIG-001. See ADR-0015. | Finance |
| MVP-OD-8 | **DECIDED:** Shared approval and transaction-safe handoff | Platform owns the one approval engine. Owner writes pending subject, version/correlation and request outbox atomically; Platform decides and emits; owner inbox validates and applies effect atomically. Effect status is tracked separately. See ADR-0015. | Finance / Platform |
| MVP-OD-9 | **DECIDED:** Reversal date and SYSTEM correction | Manual/adjustment/eligible opening reversal uses original date if OPEN, otherwise first valid date in next/current OPEN period with `latePosting=true`; formally reopened periods may receive reversal. Human SYSTEM reversal is forbidden; only registered source-domain compensating event may create it. See ADR-0015. | Finance |
| MVP-OD-10 | **DECIDED:** Gross-profit summary access | `control_station.gross_profit_summary.view`: CEO/COO at ORGANIZATION, BRANCH_MANAGER at permitted BRANCH; other non-Finance roles denied by default. Independent of full P&L and `finance.branch_pnl_visible`. See ADR-0015. | Finance / Product |
| MVP-OD-23 | Who besides the warehouse reads the stock card. INV-001 grants `inventory.stock_card.view` to "WAREHOUSE_ADMIN, FINANCE", and no registered role is called FINANCE (FINANCE_MAKER, FINANCE_APPROVER, CONTROLLER and CFO all could be meant). Raised for OpenCode's MVP-OD-20. | Identity grants it to `WAREHOUSE_ADMIN` only (`gudang.demo`, `admin.demo`). No finance role gets it until the product owner names one. `master_data.customer.view` is not a registered code (only `master_data.customer.pii.view`, §24, is), so it is not added and MVP-OD-21's default stands. | Product owner / Identity |
| MVP-OD-24 | Who declares a POS shift's cash handover. POS-014 says `CSH-DECLARE (POS_CASHIER)`; the Appendix D.1 row for `POS_CASHIER` lists only `POS-EXEC`. | Follow POS-014: `POS_CASHIER` also holds `CSH-DECLARE`. Appendix D.1 should be corrected to match. | Product owner |
| MVP-OD-25 | Concrete permission for product create/update. Appendix D gives only `master_data.*.manage` (group `MDM-MANAGE`), which Identity never expands as a wildcard. | `MDM-MANAGE` grants exactly `master_data.product.manage` (held by `MASTER_DATA_STEWARD`). Other master-data resources stay ungranted. | Product owner / Identity |
| MVP-OD-26 | What a cash count that differs from the declaration does. CSH-002 routes a discrepancy to a decision by `CSH-DISCREPANCY-APPROVE` (Branch Manager), which is not built; §8 posts shortage/overage straight from `CASH_CUSTODY_VERIFIED`. | With a registered `RC-CSH-*` reason, the verifier accepts the count: the record is `VERIFIED`, the reason is stored, and `CASH_CUSTODY_VERIFIED` carries the signed variance for Finance to post. Without a reason it stays `DISCREPANCY` for CSH-002 and publishes nothing. | Finance |
| MVP-OD-27 | Katalog pick in PSS Kasir needs a master-data read "product by id with its sellable units and barcodes". `searchProducts` returns no UoM or barcode, and POS must not accept a product name or SKU from the client. **Request to OpenCode:** export `getProductSaleUnits(pool, { organizationId, productId })` → `{ productId, sku, name, status, orderCapture, units: [{ uom, barcode \| null }] }`. | Until it lands, the katalog lists matches and adding goes through the product's barcode (resolved on the server). | OpenCode / Product owner |
| MVP-OD-28 | One product in two units (e.g. KARTON and PCS) in one counter sale. `inventory.stock_reservation` is unique per (reference, product), without the unit, so a second unit of the same product cannot be reserved. **Request to OpenCode:** include `uom` in that key (forward-only migration) or reserve in the base unit. | Until then, checkout refuses such a cart with a clear message ("Pisahkan ke transaksi lain"). Repeat scans of the same unit are merged into one line, so the demo never meets it. | OpenCode |
| MVP-OD-29 | What a POS cash declaration carries after a variance at shift close. POS-014 A1 says the cashier's count; §8 credits Kas Konter with `declaredAmount`, which balances only if the declaration equals the recorded cash payments that debited it. | The declaration stays the recorded TUNAI payments (POS-014.BR01). The cashier's count and the close variance stay on the shift, the screen tells the cashier to hand over what is actually in the drawer, and Finance's count at verification records the difference. | Finance / Product owner |
