# orders domain

Status: first real implementation (narrow slice). Confirm ownership against the Product PRD before extending behavior.

## Purpose

Owns the canonical sales order: turning a validated request (e.g. a POS counter sale) into
a confirmed `sales.sales_order` with its lines. This slice implements only the synchronous
`REQUESTED -> CONFIRMED` path of `STM-SalesOrder` (docs/PRODUCT_PRD.md Appendix E), plus
`CANCELLED`. It intentionally excludes the `VALIDATED` state, credit-hold/reservation-partial
branching, and backorder/partial-confirmation decisions, and it does not import
external-origin/ND6 orders. Those remain future work under ORD-001..009 and CRD-001..004 in
the Implementation Plan.

## Owns

- `sales.sales_order` and `sales.sales_order_line` — the canonical sales order and its lines,
  including status and computed total.

## Does not own

- Credit approval/hold decisions (domain: credit).
- Stock reservation/availability decisions (domain: inventory).
- Pricing decisions (domain: commercial).
- Fulfillment, shipment, invoicing, or collection (domains: fulfillment, invoicing, ar, payments).
- External-origin/ND6 order import and reconciliation (future work, domain: integration + orders).

## Commands

- `requestSalesOrder` — idempotent on `(organizationId, clientKey)`: creates a sales order
  (with lines) and confirms it synchronously (`REQUESTED` -> `CONFIRMED`), or replays the
  existing order if the same `clientKey` was already processed. The caller (e.g.
  `domains/pos`) is responsible for having already resolved credit, price, and stock
  availability before calling this command.
- `cancelSalesOrder` — transitions a non-terminal sales order to `CANCELLED`, recording a
  reason code.

## Queries

None implemented.

## Events produced and consumed

None implemented in this slice. `SALES_ORDER_CONFIRMED` and `SALES_ORDER_CANCELLED` are
recorded as audit entries only; outbox event publication is future work.

## Tables

- `sales.sales_order`
- `sales.sales_order_line`

## Invariants

- `(organization_id, client_key)` is unique: calling `requestSalesOrder` twice with the same
  `clientKey` for the same organization is idempotent and returns the same order, never a
  duplicate row or a duplicate audit entry — including under concurrent calls, via the unique
  constraint plus a re-select on conflict.
- `cancelSalesOrder` only transitions an order that is not already in a terminal state
  (`CANCELLED`, `REJECTED`, `COMPLETED`); otherwise it throws `INVALID_STATE_TRANSITION`.
- Every state mutation writes exactly one audit entry in the same transaction as the mutation.

## Dependencies

None. This slice does not call other domains synchronously or asynchronously. The caller is
responsible for having already resolved credit approval, price, and stock reservation before
calling `requestSalesOrder` — this slice accepts the order as `CONFIRMED` unconditionally (P0
counter sales are always paid-or-approved-credit before checkout completes per POS-005).

## Open decisions

- The full `STM-SalesOrder` `VALIDATED` step, credit-hold integration, and
  backorder/partial-confirmation decisions are out of scope for this slice (see ORD-001..009,
  CRD-001..004 in the Implementation Plan).
- External-origin/ND6 import handling is out of scope for this slice.
- DEC-100/DEC-113 `pss_mode` resolution is not applied here.

## Acceptance tests

- `domains/orders/tests/orders.integration.test.ts`: `requestSalesOrder` creates a
  `CONFIRMED` order with the server-computed total; a repeated call with the same
  `clientKey` replays the same order without a duplicate row or audit entry; concurrent
  calls with the same `clientKey` still produce exactly one order row; `cancelSalesOrder`
  transitions a non-terminal order to `CANCELLED` and throws `INVALID_STATE_TRANSITION` on
  an already-cancelled order.
