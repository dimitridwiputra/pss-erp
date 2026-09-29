# Fulfillment domain

Status: first real slice implemented — customer-pickup path only (`handover_mode = CUSTOMER_PICKUP`), enough for `domains/pos` to release a fulfillment request at checkout and confirm the customer-pickup handover at the counter (POS-010). No delivery/dispatch, no driver/WMS pick integration, no partial-short/backorder decision workflow — those remain FUL-001..005 future work.

## Purpose

Track the fulfillment of a confirmed sales order from release through customer-pickup handover: one `fulfillment_request` per release, one `delivery_order` (with its lines) recording what was ordered versus what the customer actually took away at the counter.

## Owns

`sales.fulfillment_request`, `sales.delivery_order`, and `sales.delivery_order_line` — customer-pickup path only. Delivery/dispatch (`handover_mode = 'DELIVERY'`), driver assignment, WMS pick/pack integration, and the short/backorder decision workflow are not implemented (FUL-001..005).

## Does not own

Sales order confirmation (`domains/orders`), inventory availability/reservation (`domains/inventory`), the POS sale/tender/cashier facts consumed by `confirmPickupHandover` (`domains/pos`'s own schema), and payment/credit decisioning. This domain never reads another domain's tables; callers pass in the facts they already know.

## Commands

- `releaseFulfillment(pool, client, input)` — creates one `RELEASED` `fulfillment_request` and one `PREPARED`, `CUSTOMER_PICKUP` `delivery_order` with its lines (`qty_ordered` from the input, `qty_delivered = 0`) in one audited transaction. Accepts an optional already-open `client` so a caller such as `domains/pos`'s checkout orchestration can compose this into its own transaction; opens its own transaction via `withAuditedTransaction` otherwise. Audited as `FULFILLMENT_RELEASED` against the new `FulfillmentRequest`.
- `confirmPickupHandover(pool, input)` — POS-010's guarded command. Domain owner is `fulfillment` per the PRD even though it is invoked from the counter: guard order is (a) `POS_NOT_PAID` unless `posSaleStatus` is `PAID`/`CREDIT_APPROVED` (E1), (b) `POS_ALREADY_HANDED_OVER` unless the delivery order is still `PREPARED` (covers double-serve), (c) `SEGREGATION_OF_DUTIES` (SOD-09 / POS-000.R11) when the flag is on and the confirming actor also accepted the tender, (d) per-line `VALIDATION_FAILED` when a handed-over quantity exceeds what was ordered, (e) sets `DELIVERED` only once every line of the delivery order is fully handed over, else `PARTIALLY_DELIVERED`. Always opens and commits its own transaction (it is the final step of the flow). Audited as `DELIVERY_ORDER_DELIVERED`, `receiverName` classified `PERSONAL` and quantities `PUBLIC`; `mediaIds`, if supplied, are recorded in the audit trail since no photo/attachment table exists yet in this slice.

## Queries

`getDeliveryOrderLines(pool, { deliveryOrderId })` — read-only lookup of a delivery order's lines (`id`, `productId`, `uom`, `qtyOrdered`, `qtyDelivered`). Added so a caller that only knows a `deliveryOrderId` (e.g. `domains/pos`'s pickup-handover flow, which needs product/UOM/qty to build both `ConfirmPickupHandover`'s and `domains/invoicing`'s inputs) can resolve line detail through this domain's own application layer instead of reading `sales.delivery_order_line` directly.

## Events produced and consumed

None published yet. `FULFILLMENT_RELEASED` and `DELIVERY_COMPLETED` are named in `AGENTS.md`'s event vocabulary but have no registered payload schema or outbox call in this slice; event publication is deferred, matching the audit-only pattern used elsewhere until a schema exists.

## Tables

Migration `0001_fulfillment.sql` creates schema `sales` (shared with `orders`, `credit`, `invoicing`, `returns` per `scripts/check-database.mjs`'s `schemaOwners`; created idempotently via `CREATE SCHEMA IF NOT EXISTS`, safe alongside `domains/orders`'s own migration declaring the same schema):
- `sales.fulfillment_request`: id, organization_id, sales_order_id, warehouse_id, status (`RELEASED`/`IN_PROGRESS`/`READY`/`SHIPPED`/`CLOSED_SHORT`/`CANCELLED`), timestamps.
- `sales.delivery_order`: id, organization_id, fulfillment_request_id (same-schema FK), handover_mode (`DELIVERY`/`CUSTOMER_PICKUP`), status (`PREPARED`/`DISPATCHED`/`DELIVERED`/`PARTIALLY_DELIVERED`/`NOT_DELIVERED`/`CLOSED`/`CANCELLED`), receiver_name, delivered_at, version, timestamps.
- `sales.delivery_order_line`: id, delivery_order_id (same-schema FK), product_id (plain ID reference, not a cross-domain FK), uom, qty_ordered (`numeric(18,3)`, `> 0`), qty_delivered (`numeric(18,3)`, `<= qty_ordered`).

## Invariants

- A delivery order can only be handed over (transition to `DELIVERED`/`PARTIALLY_DELIVERED`) once: `confirmPickupHandover` requires `status = 'PREPARED'` and throws `POS_ALREADY_HANDED_OVER` otherwise, guarded by a row lock (`SELECT ... FOR UPDATE`) so two concurrent confirms cannot both pass the check.
- `qty_delivered <= qty_ordered` per line, enforced by both a database `CHECK` and an application-level guard (`VALIDATION_FAILED`) before the update.
- `handover_mode` is always `CUSTOMER_PICKUP` in this slice; `releaseFulfillment` never produces a `DELIVERY` delivery order.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` for `DomainError` and registered error codes (`POS_NOT_PAID`, `POS_ALREADY_HANDED_OVER`, `SEGREGATION_OF_DUTIES`, `VALIDATION_FAILED`); `@pss/audit` for the audited-transaction boundary (`withAuditedTransaction`/`runAuditedWork`). `confirmPickupHandover` reads the PosSale status and tender-acceptor identity as plain parameters passed in by the caller — it does not query the `pos` schema directly, per the no-cross-domain-DB-access rule.

## Open decisions

- Delivery/dispatch (`handover_mode = 'DELIVERY'`), driver assignment, and WMS pick/pack integration are out of scope for this slice (FUL-001..005).
- The partial-short/backorder decision workflow (what happens when a pickup is deliberately left short) is out of scope; `confirmPickupHandover` only records whatever quantities the caller submits and computes `DELIVERED`/`PARTIALLY_DELIVERED` from them.
- `FULFILLMENT_RELEASED`/`DELIVERY_COMPLETED` event publication is deferred pending a registered payload schema in `packages/contracts`.
- `mediaIds` has no dedicated storage (no photo/attachment table); ids are only captured in the audit trail until that need is scoped.
- `releaseFulfillment`'s audit actor is a service identity and its `requestId`/`correlationId` are minted locally, since this narrow slice's input carries no upstream request context; an HTTP/orchestration layer composing this command may want to thread its own values through instead.

## Acceptance tests

`domains/fulfillment/tests/fulfillment.integration.test.ts` uses an isolated PostgreSQL database (both this domain's own migration and `domains/audit`'s migration applied, real `pg.Pool`) to verify: `releaseFulfillment` creates a `PREPARED` `CUSTOMER_PICKUP` delivery order with correct lines and an audit entry; `confirmPickupHandover` with full quantity transitions to `DELIVERED`; with partial quantity transitions to `PARTIALLY_DELIVERED`; throws `POS_NOT_PAID` when the sale is not paid/credit-approved; throws `POS_ALREADY_HANDED_OVER` on a second confirm attempt against an already-delivered order; throws `SEGREGATION_OF_DUTIES` when the confirming actor also accepted the tender and the SoD flag is on, but succeeds with the same actor when the flag is off.
