# POS domain (PSS Kasir)

Status: the P0 counter loop of §46A (PSS Kasir / POS Grosir, PRD revision 1.1) runs on the hardened API behind the MVP-OD-5 demo switch. It covers the terminal, shift, cart, checkout, cash tender, receipt, pickup handover and cash handover. QRIS (POS-007), bank transfer (POS-008), tempo/credit sale (POS-009), cancel/return (POS-012), offline mode (POS-013) and the reporting home (POS-015) are deferred; see "Open decisions".

## Purpose

Run a walk-in wholesale counter sale end to end (cart → pay → hand over barang) by orchestrating the same public commands PSS Sales uses (DEC-108), never writing another domain's tables (POS-000.R01).

## Owns

`pos.pos_terminal`, `pos.pos_shift`, `pos.pos_sale` / `pos.pos_sale_line`, `pos.pos_tender`, `pos.pos_receipt_print` and `pos.pos_offline_batch`, which are exactly the six entities POS-000.R01 names. `pos` never has a chart of accounts, price list, stock or invoice table of its own. Those live in the domains that own them (`commercial`, `inventory`, `orders`, `fulfillment`, `invoicing`, `payments`, `master-data`).

## Does not own

Pricing, stock, sales orders, delivery orders, invoices, payments, and customer master data. `pos` never emits a journal (POS-000.R02). Every cross-domain effect goes through that domain's exported command or query, composed in-process. This is a modular monolith on one Postgres cluster, so a checkout or handover is a single ACID transaction rather than a saga.

## Commands

Every command has the signature `(pool, client | undefined, input)` and runs through `@pss/platform`'s `withConnection`. Called from `runCommand`, it joins the caller's idempotent transaction (ADR-0013). Called alone, it opens its own. Every success path appends an audit entry, and the audited runner refuses to commit without one. Every input carries `actor`, `requestId`, `correlationId` and `source`, which the API resolves from the session, never from the body. Money and quantity comparisons run in Postgres, never as a JS `Number`.

- `registerPosTerminal` / `deactivatePosTerminal` (POS-001): terminal lifecycle. The POS-000.R07 "warehouse must be MANAGED" gate is a documented no-op stub, because `organization`/`principal-policy` do not exist yet. Registration is not exposed by the API: it needs the warehouse's branch from `organization`. The demo seed calls it directly.
- `openPosShift` / `closePosShift` / `forceClosePosShift` (POS-002): shift lifecycle.
  - POS-000.R08 (one OPEN shift per terminal and per cashier) is enforced by two partial unique indexes and surfaces as `POS_SHIFT_ALREADY_OPEN`.
  - Close computes expected cash on the server: `opening_float + Σ ACCEPTED TUNAI tender.amount`, already net of change (POS-006.BR01).
  - Any variance needs a registered `RC-POS-*` reason code. No close tolerance is configured, so the default is 0 and it fails closed.
- `createPosSale`, `addPosSaleLine`, `updatePosSaleLine`, `removePosSaleLine` (POS-003): cart building on an OPEN shift. `createPosSale` takes only the shift. The terminal and organization come from the shift, so a sale can't be attached to another terminal's shift. `addPosSaleLine` resolves the product from a scanned barcode (`@pss/master-data` `findProductByBarcode`) and its price (`@pss/commercial` `resolvePrice`), then snapshots both onto the line (POS-003.BR02). It no longer accepts a caller-supplied product id, SKU or name (see MVP-OD-10).
- `selectPosCustomer` / `quickRegisterPosCustomer` (POS-004): implemented and audited, but not exposed by the MVP API, because the customer menu is hidden.
- `checkoutPosSale` (POS-005): the checkout saga, all in one transaction.
  1. Lock the sale and require an OPEN shift. With no customer selected, default to the branch's walk-in customer.
  2. `reserveStock`: FULL reservation only. A shortfall surfaces as `POS_STOCK_INSUFFICIENT` and rolls everything back, leaving the sale in CART.
  3. `requestSalesOrder`, idempotent on `clientKey = posSaleId`.
  4. `releaseFulfillment`.
  5. `prepareInvoice` with `channel: 'POS'`, customer and branch.
  6. Mark the sale `PENDING_PAYMENT`.
- `acceptPosTender` (POS-006): TUNAI only. It checks cash received ≥ total in SQL. `@pss/payments` `recordPayment` stores the payment with its customer, invoice, cash location (the shift) and business date, and publishes `PAYMENT_RECEIVED` in the same transaction. The sale becomes `PAID`.
- `printPosReceipt` (POS-011): copy 1 is the original. Every later print needs a reason and is returned with `isCopy` ("SALINAN"). The sale row is locked so two prints can't share a copy number. The receipt carries the invoice number, because `KSR-{CAB}-{YYYY}-{NNNNNN}` numbering (DOC-001) awaits the owner's template (GAP-16).
- `confirmPosPickupHandover` (POS-010): full delivery only. One transaction covers:
  - `@pss/fulfillment` `confirmPickupHandover`, which holds the `POS_NOT_PAID` / `POS_ALREADY_HANDED_OVER` / SOD-09 guards and publishes `DELIVERY_ORDER_DELIVERED`;
  - `@pss/inventory` `issueInventory`, which consumes the checkout reservation;
  - `@pss/invoicing` `issueInvoice`, with the handover date as the invoice date (POS-010.BR03), which publishes `INVOICE_ISSUED`;
  - the sale's `HANDED_OVER` state.

  These steps used to commit separately, so a failure part-way left goods delivered with no invoice issued.
- `declarePosCashHandover` (POS-014): gathers the shift's ACCEPTED TUNAI payments and calls `@pss/payments` `declareCashHandover` with `source: 'POS_SHIFT'` and the shift id, then marks the shift `HANDED_OVER`, in one commit. The opening float is excluded (POS-014.BR01) and returned so the screen can say it stays in the drawer.

`syncPosOfflineBatch` (POS-013) was removed. Its replay added lines through the path that trusted a client-supplied product name and SKU, and offline mode is out of MVP scope (MVP_PLAN §9). The `pos_offline_batch` table and the `pos-offline` contract remain. Rebuild it on the hardened commands when POS-013 is scheduled.

## Queries

- `getPosTerminalScope`, `getPosShiftScope`, `getPosSaleScope`: the canonical organization, branch, warehouse, terminal and cashier of a supplied id, which the API uses for authorization.
- `listPosTerminals`: active terminals with an `inUse` flag.
- `getPosSale`: sale detail with lines and tender.
- `getPosReceipt`: receipt content for the latest print.
- `getShiftSaya`: the cashier's OPEN shift, or else a closed one not yet handed over, with cash-sales total and paid count, plus unfinished sales.
- `listPickupsAwaitingHandover`: PAID sales, oldest first.

- For the back office: `listPosSales` (checked-out sales, filtered by Jakarta business date, shift and cashier, scoped to warehouse ids in SQL, paginated), `getPosSalesListItem`, `getPosSalesSummary` (sales paid on a business date, for the dashboard), `getPosShiftSummaries` (close figures shown beside a cash handover) and `getBranchesOfWarehouses`.

All of these read only `pos` tables and accept a pool or an open client.

`printPosReceipt` takes `copyOnly` for a back-office invoice copy. A copy must follow an original print, and a sale never printed at the counter is refused (`INVALID_STATE_TRANSITION`) rather than given a "copy 1".

## API (apps/api `PosController`, behind `DemoPosFeatureGuard`)

Each route resolves the caller, resolves every supplied id through a scope query, checks the Appendix D permission at that record's warehouse, and for cashier work requires the shift to be the caller's own. Each mutation runs through `runCommand` with a required `Idempotency-Key`. An id from another organization is `NOT_FOUND`.

| Route | Permission |
|---|---|
| `GET kasir/terminals` | `pos.shift.open` (filtered per terminal) |
| `POST pos/shifts` | `pos.shift.open` |
| `POST pos/shifts/:id/close` | `pos.shift.close`, own shift |
| `POST pos/shifts/:id/cash-handover` | `payments.cash_handover.declare`, own shift |
| `GET kasir/shift-saya`, `GET kasir/products?q=`, `GET kasir/scan/:barcode` | `pos.shift.open` / `pos.sale.create` held |
| `POST pos/sales`, `POST/PATCH/DELETE pos/sales/:id/lines[/:lineId]` | `pos.sale.create`, own shift |
| `GET pos/sales/:id` | own sale with `pos.sale.create`, or `fulfillment.pickup.handover` at the warehouse |
| `POST pos/sales/:id/checkout` | `pos.sale.checkout`, own shift |
| `POST pos/sales/:id/tenders` | `pos.tender.accept`, own shift |
| `POST pos/sales/:id/receipt-prints` | `pos.tender.accept` for copy 1; `pos.receipt.reprint` for a copy |
| `GET pos/pickups`, `POST pos/sales/:id/pickup-handover` | `fulfillment.pickup.handover` at the warehouse |

Back office (`CounterBackofficeController`, also behind the switch). Lists are scoped in SQL through `scopeIdsFor`, so every page is full:

| Route | Permission |
|---|---|
| `GET pos/reports/sales?from&to&shiftId&cashierUserId&page&pageSize`, `GET pos/reports/sales/:id` | `pos.report.view` at the sale's warehouse (POS-015) |
| `POST pos/reports/sales/:id/copies` | `invoicing.invoice.print` at the sale's branch (BIL-001); always a SALINAN with a reason |
| `GET pos/reports/summary?date` | `pos.report.view`; the cash figure covers the branches of the viewer's warehouses |
| `GET payments/cash-handovers?status&page&pageSize`, `GET …/:id`, `POST …/:id/verify` | `payments.cash_custody.verify` at the handover's branch; SOD-06 and the reason rule (MVP-OD-9) in `payments` |

## Events produced and consumed

`pos` publishes nothing itself. The economic facts are published by their owners, in the same transaction as the POS command that causes them (MVP_PLAN §5):
- `PAYMENT_RECEIVED` (payments, at tender);
- `DELIVERY_ORDER_DELIVERED` (fulfillment) and `INVOICE_ISSUED` (invoicing), at pickup handover;
- `CASH_CUSTODY_VERIFIED` (payments, when Finance verifies the handover).

The POS aggregate events in Appendix C.9 (`POS_SHIFT_OPENED`, `POS_SALE_CHECKED_OUT`, …) have no payload schema and are not published. Every POS mutation is audited instead.

## Tables

Migration `0001_pos.sql` creates schema `pos`, owned solely by this domain per `scripts/check-database.mjs`'s `schemaOwners`. Cross-domain references (`customer_id`, `sales_order_id`, `delivery_order_id`, `invoice_id`, product ids, payment ids) are plain UUID columns, never foreign keys (AGENTS.md §11.1). Commands bump `version` on the aggregate they change, and the audit entry records it.

## Invariants

- One `PosSale` → at most one active `SalesOrder`, keyed by `clientKey = posSaleId` (POS-000.R03).
- Goods are never handed over before `PAID`/`CREDIT_APPROVED` (POS-000.R05), enforced in `fulfillment`'s `confirmPickupHandover`.
- The cashier who accepted the tender never confirms the handover (SOD-09). `pos.sod.cashier_not_handover` is not read from configuration yet, so it defaults on.
- At most one `OPEN` shift per terminal and per cashier (POS-000.R08).
- A cart changes only while its shift is OPEN.
- The product on a line always comes from master-data, never from the caller.
- `pos` never produces a journal or calls `finance` (POS-000.R02).

## Dependencies

`@pss/platform` (`withConnection`), `@pss/contracts`, `@pss/master-data`, `@pss/commercial`, `@pss/inventory`, `@pss/orders`, `@pss/fulfillment`, `@pss/invoicing`, `@pss/payments`, all called as in-process function imports.

## Open decisions

- MVP-OD-10: katalog pick needs a master-data "product by id with sellable units" query. Until then the katalog lists matches and adding is by barcode.
- POS-000.R07 (warehouse MANAGED before a terminal opens) is a no-op stub pending `organization`/`principal-policy`.
- `checkoutPosSale`'s invoice `branchCode` is derived from the branch UUID as a placeholder, since `organization` doesn't exist yet.
- Receipt numbering `KSR-…` awaits GAP-16. The receipt shows the invoice number.
- The price list scope is the constant `KONTER` until PLT-009 supplies it.
- `pos.sod.cashier_not_handover` and a shift close tolerance are not read from configuration yet. Both default to the fail-closed value.
- POS-007/008/009/012/013/015 are deferred by explicit scope choice (MVP_PLAN §9).
- The cart-time stock indicator (POS-003.BR03) awaits a read-only availability query on `domains/inventory`.

## Acceptance tests

- `tests/integration/pos-checkout-flow.integration.test.ts` runs the P0 loop across all eight domains. It covers the float-money refusal, SOD-09, and the three §5 events with their payloads, each passing `parseEventForPublication`.
- `apps/api/tests/pos.integration.test.ts` runs the counter flow over HTTP as `kasir` then `gudang`. It covers the negative paths from NEXT_IMPLEMENTATION_PLAN §2:
  - unauthenticated;
  - missing key, wrong role, no role, wrong warehouse/branch, wrong organization, another cashier's shift;
  - a body that tries to set the organization, price list, cashier or product;
  - stale state, replay, key reuse, insufficient stock, malformed ids and money;
  - a single publication of each event under retry.
- `apps/api/tests/demo-pos-guard.integration.test.ts` covers the demo switch.
