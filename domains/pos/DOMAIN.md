# POS domain (PSS Kasir)

Status: first real slice implementing the P0 core loop of §46A (PSS Kasir / POS Grosir, PRD revision 1.1): terminal, shift, cart, checkout, cash tender, pickup handover, receipt, cash handover, and offline emergency mode. QRIS (POS-007), bank transfer (POS-008), tempo/credit sale (POS-009), cancel/return (POS-012), and the reporting home (POS-015) are deferred — see "Open decisions" below.

## Purpose

Run a walk-in wholesale counter sale end to end — cart → pay → hand over barang — by orchestrating the same public commands PSS Sales uses (DEC-108), never writing another domain's tables (POS-000.R01).

## Owns

`pos.pos_terminal`, `pos.pos_shift`, `pos.pos_sale` / `pos.pos_sale_line`, `pos.pos_tender`, `pos.pos_receipt_print`, `pos.pos_offline_batch` — exactly the six entities POS-000.R01 names. `pos` never has a chart of accounts, price list, stock, or invoice table of its own; those live in the domains that own them (`commercial`, `inventory`, `orders`, `fulfillment`, `invoicing`, `payments`, `master-data`).

## Does not own

Pricing, stock, sales orders, delivery orders, invoices, payments, or customer master data. `pos` never emits a journal (POS-000.R02) and never reads another domain's schema directly — every cross-domain effect goes through that domain's own exported command/query, composed in-process (this is a modular monolith sharing one Postgres cluster, so a checkout can be one ACID transaction across domains rather than a multi-step saga).

## Commands

- `registerPosTerminal` / `deactivatePosTerminal` (POS-001) — terminal lifecycle. The POS-000.R07 "warehouse must be MANAGED" gate is a documented no-op stub (`assertWarehouseManaged`): `organization`/`principal-policy` don't exist yet in this build.
- `openPosShift` / `closePosShift` / `forceClosePosShift` (POS-002) — shift lifecycle. `POS-000.R08` (one OPEN shift per terminal/cashier) is enforced by two partial unique indexes, not application logic. `closePosShift` computes expected cash server-side (`opening_float + Σ ACCEPTED TUNAI tender.amount`, already net of change per POS-006.BR01) and requires a `reasonCode` outside `closeTolerance`.
- `createPosSale`, `addPosSaleLine`, `updatePosSaleLine`, `removePosSaleLine`, `holdPosSale` (POS-003) — cart building. `addPosSaleLine` resolves the product (via `@pss/master-data`'s `findProductByBarcode`, or a caller-supplied `productId`+`uom`+`sku`+`name` from a prior katalog search — master-data exposes no "product by id" query) and its price (via `@pss/commercial`'s `resolvePrice`), snapshotting both onto the line. The cart-time stock indicator (POS-003.BR03, informational only) is not implemented — `inventory` exposes no read-only availability query yet, only mutating reserve/release/issue commands.
- `selectPosCustomer` / `quickRegisterPosCustomer` (POS-004) — attaches an existing customer, or quick-registers one via `@pss/master-data`'s `createCustomer` (pos never writes the customer table).
- `checkoutPosSale` (POS-005) — the checkout saga: locks the sale and its lines, defaults to the branch's walk-in customer if none was selected (`@pss/master-data`'s `getOrCreateWalkInCustomer`), then in one shared transaction calls `@pss/inventory`'s `reserveStock` (FULL only — any shortfall rolls back everything), `@pss/orders`'s `requestSalesOrder` (idempotent on `clientKey = posSaleId`), `@pss/fulfillment`'s `releaseFulfillment`, and `@pss/invoicing`'s `prepareInvoice`, then marks the sale `PENDING_PAYMENT`.
- `acceptPosTender` (POS-006) — TUNAI only in this slice (QRIS/transfer are POS-007/008). Records the tender and calls `@pss/payments`'s `recordPayment`; marks the sale `PAID` once the (single, full-amount) tender covers the total. No split-tender across methods yet.
- `confirmPosPickupHandover` (POS-010) — full-delivery only in this slice (no partial-pickup UI). Resolves the delivery order's lines via `@pss/fulfillment`'s `getDeliveryOrderLines` (a query added to `domains/fulfillment` for this purpose, since `pos` cannot read `sales.*` directly), calls `confirmPickupHandover` (guards `POS_NOT_PAID`/`POS_ALREADY_HANDED_OVER`/`SEGREGATION_OF_DUTIES` — SOD-09 — live in `fulfillment`, since that's the PRD's named domain owner for this command even though the facts it guards on originate in `pos`) and then `@pss/invoicing`'s `issueInvoice`, before marking the sale `HANDED_OVER`.
- `printPosReceipt` (POS-011) — first print is copy 1; every later print requires a reason and is copy N ("SALINAN").
- `declarePosCashHandover` (POS-014) — gathers the shift's ACCEPTED TUNAI payments and calls `@pss/payments`'s `declareCashHandover`, then marks the shift `HANDED_OVER`. Verification (`verifyCashCustody`) is a Finance-side action on `@pss/payments`, not exposed here.
- `syncPosOfflineBatch` (POS-013) — replays a batch of offline cash sales through the normal online path (create → add lines → checkout → tender) so each gets the same server-side guards as an online sale. Idempotent per sale `number` (the offline block's number is unique per organization); a failure on one sale is recorded `NEEDS_REVIEW` and does not abort the rest of the batch.

## Queries

`getPosSale`, `getShiftSaya` — read models backing `GET /kasir/shift-saya` and sale detail. Not idempotent-projector-backed read models in the CST-001 sense (no separate `reporting.*` table) — they query `pos`'s own tables directly, which is fine since `pos` owns them.

## Events produced and consumed

None published yet. `POS_TERMINAL_UPDATED`, `POS_SHIFT_OPENED`, `POS_SHIFT_CLOSED`, `POS_SALE_CHECKED_OUT`, `POS_TENDER_ACCEPTED`, `POS_SALE_PAID`, `POS_SALE_HANDED_OVER`, `POS_OFFLINE_BATCH_SYNCED` are registered in Appendix C.9 (`packages/contracts/src/events/catalog.generated.ts`) but have no payload schema in `eventSchemaRegistry` yet, matching the same deferred-event pattern used by every sibling domain built this session (`CUSTOMER_CREATED`, `FULFILLMENT_RELEASED`, etc.) — wire the real `appendOutboxEvent` calls once payload schemas exist.

## Tables

Migration `0001_pos.sql` creates schema `pos` (owned solely by this domain per `scripts/check-database.mjs`'s `schemaOwners`): `pos_terminal`, `pos_shift` (two partial unique indexes enforce POS-000.R08), `pos_sale` / `pos_sale_line`, `pos_tender`, `pos_receipt_print`, `pos_offline_batch`. All cross-domain references (`customer_id`, `sales_order_id`, `delivery_order_id`, `invoice_id`, product ids, payment ids) are plain UUID columns, never foreign keys, per AGENTS.md §11.1.

## Invariants

- One `PosSale` → at most one active `SalesOrder`, keyed by `clientKey = posSaleId` (POS-000.R03).
- Goods are never handed over before `PAID`/`CREDIT_APPROVED` (POS-000.R05) — enforced in `fulfillment`'s `confirmPickupHandover`, not re-checked in `pos`.
- At most one `OPEN` shift per terminal and per cashier (POS-000.R08), enforced by database partial unique indexes.
- `pos` never produces a `JOURNAL_POSTED` event or calls `finance` — posting is entirely a reaction to the owning domains' own events (POS-000.R02), none of which are wired to Finance yet since `domains/finance` doesn't exist in this build either.

## Dependencies

`@pss/audit` (`withAuditedTransaction`/`runAuditedWork`), `@pss/contracts` (`DomainError`, registered error codes), `@pss/master-data`, `@pss/commercial`, `@pss/inventory`, `@pss/orders`, `@pss/fulfillment`, `@pss/invoicing`, `@pss/payments` — all called as in-process function imports (workspace packages), never over HTTP, matching how `domains/identity` is already consumed by `apps/api`.

## Open decisions

- POS-000.R07 (warehouse must be INVENTORY/FULFILLMENT MANAGED before a terminal can open) is a documented no-op stub pending the `organization`/`principal-policy` domains.
- `checkoutPosSale`'s invoice `branchCode` is derived from the branch UUID as a placeholder (`organization` doesn't exist yet to supply a real short code).
- `EvaluateCredit`/tempo (POS-009), QRIS (POS-007), transfer (POS-008), cancel/return (POS-012), and the reporting home (POS-015) are not implemented — deferred by explicit scope choice for this build increment, not silently dropped (see the repo's plan file for the phase breakdown).
- The cart-time stock availability indicator (POS-003.BR03) is not implemented, pending a read-only query on `domains/inventory`.

## Acceptance tests

None yet in this domain package — the P0 loop is exercised end to end by `tests/integration/pos-checkout-flow.integration.test.ts` at the repo root (spans `pos` + all seven dependency domains), plus each dependency domain's own `tests/*.integration.test.ts`.
