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
Create/update product, barcode and UoM; list/search customers; set and activate prices; moving-average costing on inventory; inventory events; goods receipt with unit cost; stock adjustment with reason; stock balance/movement queries; back-office screens; dashboard. The one permitted WMS change: where WMS calls `receiveStock`, state `unitCost: null` **and** `sourceType: 'WMS_RECEIPT'` explicitly. Two fields rather than one, because `sourceType` is the whole of `INVENTORY_RECEIVED`'s `sourceType` and a default would let a mislabelled receipt reach the General Ledger's posting rules. Still a single edit to a single call site in a frozen domain; it is in `domains/wms/src/application/receive-goods.ts`.

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

Other defaults: calendar-month periods in Asia/Jakarta; moving-average cost per warehouse, product and UoM; PPN posted only from the invoice's own `taxAmount`, which is the customer's PPN switch applied at checkout (MVP-OD-3) — zero for a customer without PPN, so PPN Keluaran is used only once a customer's PPN is on; manual journals need a different approver (AGENTS.md §4.5). Payment is posted before the invoice in the POS flow, so Piutang Usaha carries a temporary credit balance between payment and handover. This is expected and must be shown correctly in the reconciliation.

## 9. Out of scope (say so openly in the demo)

QRIS, transfer, credit (tempo) sales, returns, purchase orders and AP invoices, tax/e-Faktur, multiple branches, ND6/FoxPro integration, offline sync, hosted deployment, fixed assets, bank reconciliation.

## 10. Decision registry (open items use demo defaults; production blocked until sign-off)

| ID | Decision | Default | Owner |
|---|---|---|---|
| MVP-OD-1 | Chart of accounts | §8 table | Finance |
| MVP-OD-2 | Posting rules | §8 table | Finance |
| MVP-OD-3 | PPN status, rate, price-inclusive | **Demo (decided 2026-10-01 by the product owner): PPN is per customer, switched on or off on Pelanggan, the walk-in customer included.** Every demo product is `VAT_OUTPUT`; the customer's `NON_VAT` makes a sale tax-free, `VAT_OUTPUT` charges PPN on top of the counter price (price-exclusive) at the demo rate `PSS_DEMO_PPN_RATE` (default 11), rounded `HALF_UP` per line. The walk-in starts with PPN off (`PSS_DEMO_WALK_IN_PPN=on` starts it on), so the runbook's amounts hold. **Still open for production:** PKP status, the statutory rate and DPP rule, price-inclusive pricing, and who may set a customer's treatment (gated on the steward grant, as MVP-OD-21). The seed writes the rate and the two tax config values as a demo fixture; production goes through `scheduleTaxRate` and PLT-009 with their approvals. | Finance/Tax / Product owner |
| MVP-OD-4 | Costing method, and the granularity of the average. | Moving average, per **warehouse × product × UoM** — `inventory.stock_balance` is unique per `(warehouse_id, product_id)` and carries one `uom`, so the average is scoped exactly that way. The PRD's `inventory.valuation_unit` default is BRANCH, which is MVP-OD-12. | Finance |
| MVP-OD-5 | POS API demo exposure | Server-side `PSS_DEMO_POS_ENABLED`, off by default, refused in production | Engineering owner |
| MVP-OD-6 | Demo data | Synthetic sample products | Product owner |
| MVP-OD-7 | **DECIDED:** Control-account roles and manual posting | `AR_CONTROL`, `AP_CONTROL`, `GRNI`, `INVENTORY`, `INVENTORY_IN_TRANSIT`, `INVENTORY_IN_TRANSFER`, financially valued `INVENTORY_QUARANTINE`, `UNAPPLIED_RECEIPTS`, `CUSTOMER_DEPOSITS`, `CASH_IN_TRANSIT`: `manual_posting_policy=DENY`. Use `AccountRoleMapping`; opening balances use MIG-001. See ADR-0015. | Finance |
| MVP-OD-8 | **DECIDED:** Shared approval and transaction-safe handoff | Platform owns the one approval engine. Owner writes pending subject, version/correlation and request outbox atomically; Platform decides and emits; owner inbox validates and applies effect atomically. Effect status is tracked separately. See ADR-0015. | Finance / Platform |
| MVP-OD-9 | **DECIDED:** Reversal date and SYSTEM correction | Manual/adjustment/eligible opening reversal uses original date if OPEN, otherwise first valid date in next/current OPEN period with `latePosting=true`; formally reopened periods may receive reversal. Human SYSTEM reversal is forbidden; only registered source-domain compensating event may create it. See ADR-0015. | Finance |
| MVP-OD-10 | **DECIDED:** Gross-profit summary access | `control_station.gross_profit_summary.view`: CEO/COO at ORGANIZATION, BRANCH_MANAGER at permitted BRANCH; other non-Finance roles denied by default. Independent of full P&L and `finance.branch_pnl_visible`. See ADR-0015. | Finance / Product |
| MVP-OD-23 | Who besides the warehouse reads the stock card. INV-001 grants `inventory.stock_card.view` to "WAREHOUSE_ADMIN, FINANCE", and no registered role is called FINANCE (FINANCE_MAKER, FINANCE_APPROVER, CONTROLLER and CFO all could be meant). Raised for OpenCode's MVP-OD-20. | Identity grants it to `WAREHOUSE_ADMIN` only (`gudang.demo`, `admin.demo`). No finance role gets it until the product owner names one. `master_data.customer.view` is not a registered code (only `master_data.customer.pii.view`, §24, is), so it is not added and MVP-OD-21's default stands. | Product owner / Identity |
| MVP-OD-25 | Product categories on the counter (a tabbed product grid in PSS Kasir, asked for in the UI pass of 2026-10-01). Master data stores no product category: the demo seed's categories exist only in the seed script. | The counter keeps scan plus katalog search. **Request to OpenCode:** a product category in master data (a reference table, AGENTS.md §11.1) and on `searchProducts`, if the product owner wants one. The category list itself is the product owner's. | Product owner / OpenCode |
| MVP-OD-24 | Who declares a POS shift's cash handover. POS-014 says `CSH-DECLARE (POS_CASHIER)`; the Appendix D.1 row for `POS_CASHIER` lists only `POS-EXEC`. | Follow POS-014: `POS_CASHIER` also holds `CSH-DECLARE`. Appendix D.1 should be corrected to match. | Product owner |
| MVP-OD-32 | Concrete permission for product create/update. Appendix D gives only `master_data.*.manage` (group `MDM-MANAGE`), which Identity never expands as a wildcard. | `MDM-MANAGE` grants exactly `master_data.product.manage` (held by `MASTER_DATA_STEWARD`). Other master-data resources stay ungranted. | Product owner / Identity |
| MVP-OD-26 | What a cash count that differs from the declaration does. CSH-002 routes a discrepancy to a decision by `CSH-DISCREPANCY-APPROVE` (Branch Manager), which is not built; §8 posts shortage/overage straight from `CASH_CUSTODY_VERIFIED`. | With a registered `RC-CSH-*` reason, the verifier accepts the count: the record is `VERIFIED`, the reason is stored, and `CASH_CUSTODY_VERIFIED` carries the signed variance for Finance to post. Without a reason it stays `DISCREPANCY` for CSH-002 and publishes nothing. | Finance |
| MVP-OD-27 | Katalog pick in PSS Kasir needs a master-data read "product by id with its sellable units and barcodes". `searchProducts` returns no UoM or barcode, and POS must not accept a product name or SKU from the client. **Request to OpenCode:** export `getProductSaleUnits(pool, { organizationId, productId })` → `{ productId, sku, name, status, orderCapture, units: [{ uom, barcode \| null }] }`. | **Landed** (Day 3, `mvp/backoffice`): `getProductSaleUnits(pool, { organizationId, productId })` — the two-argument read shape the POS stream asked for, so a POS caller cannot pass a body where a client is expected. It is a projection of the one query behind `getProduct`, so the two cannot disagree about which units a product sells. POS side (`mvp/pos-catalog`): the katalog opens a product, offers its units that have a counter price (`GET kasir/products/:productId/units`), and adds one with `{ productId, uom }`. The server checks the unit against this read and prices it itself. | OpenCode / Product owner |
| MVP-OD-28 | One product in two units (e.g. KARTON and PCS) in one counter sale. `inventory.stock_reservation` was unique per (reference, product), without the unit. **Request to OpenCode:** include `uom` in that key (forward-only migration) or reserve in the base unit. | **Partly landed** (`mvp/backoffice` 0005): the reservation key now includes `uom`. **Still open:** `inventory.stock_balance` is counted in one unit per product (the seed stocks in KARTON), and `reserveStock`/`issueInventory` subtract a line's `qty` from it without checking or converting the line's unit, so 3 PCS would reserve 3 KARTON. **Request to OpenCode:** refuse a line whose `uom` differs from the balance's (a stable error POS can show), or convert by the master-data factor. Until then checkout keeps refusing a two-unit cart ("Pisahkan ke transaksi lain"). The demo prices one unit per product, so it never meets this. | OpenCode |
| MVP-OD-29 | What a POS cash declaration carries after a variance at shift close. POS-014 A1 says the cashier's count; §8 credits Kas Konter with `declaredAmount`, which balances only if the declaration equals the recorded cash payments that debited it. | The declaration stays the recorded TUNAI payments (POS-014.BR01). The cashier's count and the close variance stay on the shift, the screen tells the cashier to hand over what is actually in the drawer, and Finance's count at verification records the difference. | Finance / Product owner |
| MVP-OD-30 | Who approves the final accounting-period close in the five-user demo. CLS-005 and Appendix D require `finance.close.approve` (CFO by default), but the seeded checker `kepala.keuangan.demo` is CONTROLLER and has only `finance.close.manage`. | Controller soft-closes and requests final close. The request remains pending; do not grant `CLS-APPROVE` to the Controller. Provision a distinct authorized approver only after the product owner confirms the demo actor. | Product owner / Identity / Finance |

Open decisions raised by **OpenCode** (back office). Each one is a business question the MVP had no
answer for; the demo proceeds on the stated default and none of them is a decision in disguise.

| ID | Decision | Default | Owner |
|---|---|---|---|
| MVP-OD-12 | Valuation unit. The PRD's `inventory.valuation_unit` defaults to BRANCH, so one average covers every warehouse in a branch. | **WAREHOUSE**: `stock_balance` is unique per `(warehouse_id, product_id)`, so the moving average is per warehouse × product × UoM (MVP-OD-4). A branch-level average would need a second balance key and a rule for goods received at one warehouse and sold from another. | Finance |
| MVP-OD-13 | Unit-cost precision. INV-003.BR01 says `inventory.cost_precision`, default **6** decimals for unit cost and 2 for value. The §5 event payload declared `unitCost` as 2-place money (`MoneyV1`), one below the ledger's `numeric(18,4)`. | **4** decimals in the ledger (`numeric(18,4)`) and **2** for every total. **Answered on 30 September:** the payload's `unitCost` is now a 4-place format (`UnitCostV1`), and `inventory`'s producer publishes the ledger's own value, so a moving average is no longer rounded on the way out. `totalCost` stays 2-place and remains authoritative — finance posts `totalCost`, never `qty × unitCost` (§8). Raising the ledger scale later is a widening migration that cannot lose a stored value. | Finance |
| MVP-OD-14 | Price-change approval. COM-001 requires it: the main flow is "mengajukan → approval `price_list_activation`", RBAC is `commercial.price_list.manage` plus "approval per level `approval.price_list_activation.levels`", and COM-001.AC03 rejects proposer = approver. | **Demo: no approval step.** The existing `activatePriceList` activates a whole list in one transaction, and the /kantor Harga screen edits a DRAFT list and activates it. No approval levels, no `PENDING_APPROVAL` transition, no `APPROVAL_DECIDED` consumer, and no proposer/approver separation are built. Production is blocked on this. | Product owner / Finance |
| MVP-OD-15 | Stock-adjustment reason vocabulary scope. The PRD names a `reasonCode` on adjustments but says nothing about who may add one. | The **registered** Appendix F.3 codes, in one platform-level reference table `inventory.stock_adjustment_reason` (no `organization_id`): the `RC-INV-*` set for adjustments plus the `RC-WMS-*` codes `domains/wms` already writes. An inactive code still resolves its label for movements already written against it. | Product owner / Ops |
| MVP-OD-19 | **Which reason codes the demo's Penyesuaian Stok screen offers.** The demo plan named four plain names — `RUSAK`, `HILANG`, `SELISIH_HITUNG`, `KOREKSI` — and **none of them is in the PRD's Appendix F.3**, which registers a code vocabulary instead, requires every list to carry an `…_OTHER` with a mandatory note, and says a code is never shown raw to a user. | The table is seeded with the registered codes, each carrying the Indonesian label the brief's four names describe: `RC-INV-DAMAGED` = "Barang rusak", `RC-INV-LOST` = "Barang hilang", `RC-INV-COUNT_VARIANCE` = "Selisih hasil hitung fisik", `RC-INV-OTHER` = "Lainnya — wajib isi keterangan". The screen shows the label, never the code. **Not decided:** whether `KOREKSI` deserves its own registered code rather than folding into `…_OTHER`, and F.3's "mandatory note" for `…_OTHER` — there is no note field on an adjustment today, so choosing `RC-INV-OTHER` records the code with no explanation. | Product owner / Ops |
| MVP-OD-16 | A **valued** receipt arriving when the balance still holds unvalued quantity (for example stock a WMS receipt brought in without a cost). | Both stay unvalued: the movement records `unitCost: null` and the balance keeps `avg_unit_cost = NULL`, so finance routes it to the exception queue (§5, AGENTS.md §3.7). Valuing that quantity is a **stock revaluation**, which the MVP does not have, and the alternatives all invent a number — treat the unvalued quantity as free goods, or re-average over valued quantity only. Neither may be chosen without Finance. | Finance |
| MVP-OD-20 | **No registered read permission for the back-office master and stock screens.** Appendix D registers no `master_data.product.view`, no customer read permission, and no group grants the PRD's `inventory.stock_card.view` (which INV-001 names for the stock card at WAREHOUSE_ADMIN/FINANCE) — so `resolveRolePermissions` returns nothing for it and gating on it would refuse every user. | **Half answered on 30 September:** Identity registered `inventory.stock_card.view` and granted it to WAREHOUSE_ADMIN, so `GET /inventory/stock-balances`, `GET /inventory/stock-movements` and the reason list now gate on the permission INV-001 names, at the same warehouse scope. The **Barang and Pelanggan reads still have no code of their own** and stand on the steward write grant `master_data.product.manage`, because `master_data.product.view` and `master_data.customer.view` are not registered and are not added here. **Request to Identity, still open:** a registered read code for the product and the customer. | Identity / Product owner |
| MVP-OD-21 | **The Pelanggan list has no permission of its own.** MVP-OD-8 deliberately left every master-data resource except the product ungranted, so no role can read a customer under a registered code. | The read-only Pelanggan list is gated on `master_data.product.manage` — the steward grant the adjacent Barang screen uses — and the gap is recorded rather than papered over with a new code. Access is a superset of what the PRD registers; Product owner decides whether that is right for customer data before production. | Product owner |
| MVP-OD-22 | **No domain exposes a warehouse-by-id → organization read the back office can call.** `wms.warehouse_config` is the registry, and `domains/wms` is frozen, so a goods receipt's `warehouseId` cannot be resolved against a canonical owner. | Two partial gates, both honest about their limit. The permission check is at the caller's own warehouse scope, so a warehouse-scoped administrator can only name their own. `inventory` additionally refuses a warehouse that already holds stock for **another** organization — a fact in its own `stock_balance` — as `NOT_FOUND`. A warehouse id nobody has ever stocked is still accepted, because nothing in this build can say it does not exist. **Request:** `organization` (or `wms` once unfrozen) should expose `getWarehouseScope(id) → { organizationId, branchId, warehouseId }`, the shape `pos.getPosTerminalScope` already uses. | Engineering owner / WMS owner |
| MVP-OD-17 | The low-stock threshold for the dashboard tile. No configuration key for it exists: `packages/contracts`' registry has no `inventory.min_stock` / reorder-point key, and `assertKnownConfigKey` throws `CONFIG_KEY_UNKNOWN` for an unregistered one, so the value cannot be read from configuration yet. | The threshold is an **input to the query**, not a constant inside it: `listStockBalances(pool, client, { organizationId, warehouseId, maxQty })` — the caller supplies the threshold and the screen shows the one it used. For the demo the caller supplies `PSS_DASHBOARD_LOW_STOCK_MIN_QTY` (default `10`), and the screen shows the threshold it used. Adding the key needs a new Appendix N row, which is a PRD change, not an engineering one. | Product owner / Finance |
| MVP-OD-31 | **The dashboard's gross-profit tile has no source.** `apps/finance-api` publishes only `/health`, so no read reports today's or this month's gross profit, and the BFF cannot compose a margin from a sale and a cost — that would be a finance rule in a dashboard (AGENTS.md §3.1, MVP_PLAN §4). | The tile exists, reads a provisional path, and **degrades to "Belum tersedia"** with the reason on screen; it is never rendered as Rp 0, which would read as "no profit". The provisional contract is one place: `FINANCE_SUMMARY_PATH` and `FinanceGrossProfitSchema` in `apps/web/lib/kantor/dashboard.ts`, and its shape is asserted by `tests/kantor-dashboard.test.ts`. **Request to Finance:** publish the read as a contract in `packages/contracts` and confirm or correct that path and those two money fields; nothing else in the tile changes. | Finance / Engineering owner |

**ID reconciliation (merge of the POS, back-office and finance streams, 2026-10-01).** The streams
numbered in parallel. The finance stream's IDs stand because ADR-0015 and the PRD already cite them:
MVP-OD-7…10 are Finance's, and the POS rows formerly numbered 7, 8, 9, 10, 11 and 12 are now 24, 32,
26, 27, 29 and 28. The back office's second MVP-OD-23 (the gross-profit tile) is MVP-OD-31.
Applied migrations are checksummed and keep their original text, so two comments there still use
the old number: `domains/inventory/.../0005_inventory_reservation_uom_key.sql` says MVP-OD-12 and
means **MVP-OD-28**; `0003_inventory_costing.sql`'s MVP-OD-12 is the valuation unit and is correct.
