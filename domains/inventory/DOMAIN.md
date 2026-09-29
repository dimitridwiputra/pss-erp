# Inventory domain

Status: first real slice implemented. A minimal per-(warehouse, product) on-hand/reserved balance,
FULL-only reservation, and an append-only issue/receive/adjustment movement ledger exist to let
`domains/pos` reserve stock at checkout and issue it at pickup handover, and to let `domains/wms`
receive goods and post discrepancy corrections. Costing/valuation, lot/expiry tracking, transfers,
and partial/backorder reservation remain future work (INV-001..009).

## Purpose

Track how much of each product is on hand and reserved per warehouse, and record what has been
issued out of that stock, so other domains (starting with `domains/pos`) can make FULL-only
reservation and issue decisions against a single, audited source of truth.

## Owns

`inventory.stock_balance` (on-hand/reserved quantity per warehouse+product), `inventory.stock_reservation`
(one row per reserved line, keyed by an external reference), and `inventory.stock_movement` (an
append-only ledger of issues). No other domain writes these tables.

## Does not own

Costing/valuation, lot/expiry/serial tracking, warehouse transfers, purchasing/receiving, or
partial/backorder reservation logic. It does not own the checkout, order, or fulfilment aggregate
itself — `reference_type`/`reference_id` are opaque to this domain; the caller (e.g. `domains/pos`)
owns what that reference means.

## Commands

- `reserveStock(pool, client, input)` — reserves every line of `input.lines` for
  `(input.referenceType, input.referenceId)` in one all-or-nothing transaction (POS-005.BR02: FULL
  reservation only, no partial/backorder). Locks each `(warehouseId, productId)` balance row
  (`SELECT ... FOR UPDATE`, auto-creating a zero-balance row when one does not exist yet), and
  checks `qty_on_hand - qty_reserved >= qty` in SQL so the comparison stays decimal-exact. If any
  line is short, throws `DomainError('INSUFFICIENT_STOCK', [], fieldErrors)` (one field error per
  short line) and the whole transaction rolls back — nothing is partially reserved. Otherwise
  inserts one `ACTIVE` `stock_reservation` row per line, increments `qty_reserved`, and appends one
  `STOCK_RESERVED` audit entry for the whole reservation. Returns `{ reservationIds }`.
- `releaseReservation(pool, client, input)` — releases every `ACTIVE` reservation for
  `(input.referenceType, input.referenceId)`, marking it `RELEASED` and returning its qty to
  `qty_reserved`. Idempotent/retry-safe: a reference with nothing `ACTIVE` left is a no-op
  (`{ releasedCount: 0 }`), and — because no mutation happens on that path — no audit entry is
  written for it either (an audit entry is only ever written alongside a real mutation). Audit
  action `STOCK_RESERVATION_RELEASED` when it does mutate something.
- `issueInventory(pool, client, input)` — for each line, decrements both `qty_on_hand` and
  `qty_reserved` by the qty given (which may be less than the qty originally reserved — partial
  pickup, POS-010), marks the matching `ACTIVE` reservation `CONSUMED`, and inserts one `ISSUE`
  `stock_movement` row. Leaving any remaining reserved qty on a partially-picked-up line to be
  explicitly released is the caller's responsibility, not this function's. Audit action
  `INVENTORY_ISSUED`.

- `receiveStock(pool, client, input)` — WMS-003 (no-PO simplification, OD-136): increases
  `qty_on_hand` for each line (auto-creating a zero-balance row when one does not exist yet) and
  inserts one `RECEIVE` `stock_movement` row per line. Bypasses the full spec's
  `procurement.PostGoodsReceipt` PO-matching/costing step, which does not exist yet — this command
  is called directly by `domains/wms`'s receiving flow instead and records no unit cost. Audit
  action `INVENTORY_RECEIVED`.
- `adjustStock(pool, client, input)` — WMS-010/011 (simplified): applies a signed `qtyDelta` per
  line directly to `qty_on_hand` (surplus positive, shortage negative) and inserts one `ADJUSTMENT`
  `stock_movement` row per line. Guarded in SQL so a correction can never drop `qty_on_hand` below
  `qty_reserved` (`UPDATE ... WHERE qty_on_hand + $qtyDelta >= qty_reserved`); throws
  `DomainError('VALIDATION_FAILED', ...)` and rolls back if it would. Bypasses the full INV-006
  approval workflow (REQUESTED → APPROVED → POSTED), which does not exist yet — applies immediately
  as if already POSTED. Audit action `INVENTORY_ADJUSTED`, carrying the line's `reasonCode`.

All five accept an already-open `PoolClient` so a caller such as `domains/pos`'s checkout
orchestration or `domains/wms`'s receiving/discrepancy flows can share one transaction across
multiple domain calls; when `client` is omitted each command opens (and commits/rolls back) its own
transaction the same way `withAuditedTransaction` does.

## Queries

- `getStockBalances(pool, client, { warehouseId })` — every product's `qty_on_hand`/`qty_reserved`
  for one warehouse. Read-only, no audit entry. Added for `domains/wms`'s WMS-002 activation
  reconciliation (comparing Σ physical stock to the financial balance without reading
  `inventory.stock_balance` directly from another domain's code).

## Events produced and consumed

None yet. `INVENTORY_ISSUED` is a canonical event name reserved by AGENTS.md §10 for a future
outbox-published event once a consumer needs it; this slice only writes the audited mutation and
the movement row, it does not publish an event.

## Tables

Migration `0001_inventory.sql` creates the `inventory` schema (owned solely by this domain per
`scripts/check-database.mjs`'s `schemaOwners`) with `stock_balance` (unique per
`(warehouse_id, product_id)`, `qty_reserved <= qty_on_hand`, `qty_reserved >= 0`),
`stock_reservation` (unique per `(reference_type, reference_id, product_id)`, status
`ACTIVE`/`CONSUMED`/`RELEASED`), and `stock_movement` (append-only, `movement_type`
`ISSUE`/`ADJUSTMENT`). Migration `0002_inventory_receive_adjust.sql` widens `stock_movement`'s
`movement_type` CHECK to also allow `RECEIVE`, so the ledger now records `RECEIVE` (from
`receiveStock`), `ISSUE` (from `issueInventory`), and `ADJUSTMENT` (from `adjustStock`). No foreign
key reaches another domain's schema.

## Invariants

- `qty_reserved <= qty_on_hand` always (enforced by a table `CHECK`, not just application code).
- `qty_reserved >= 0` always (enforced by a table `CHECK`); an `issueInventory` call that would
  decrement more than is reserved fails that constraint and rolls back rather than going negative.
- Reservation is all-or-nothing per `reserveStock` call: either every requested line gets reserved,
  or none do.
- At most one `ACTIVE` reservation exists per `(reference_type, reference_id, product_id)` (unique
  index); `issueInventory`/`releaseReservation` match against that row, not against a caller-passed
  reservation ID.
- A state mutation always has an audit entry (`runAuditedWork` rejects a callback that never
  audits); a genuine no-op (nothing `ACTIVE` to release) is the only path that skips both.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` for `DomainError`/`INSUFFICIENT_STOCK`/`DecimalStringSchema`;
`@pss/audit` for the mandatory `withAuditedTransaction`/`runAuditedWork` audit boundary. No
dependency on another domain's database schema.

## Open decisions

- OD-107 (costing method) is not applied to `stock_movement` in this minimal slice — there is
  deliberately no cost/value column on it yet; costing/valuation is INV-001..009 future work.
- `releaseReservation` and `issueInventory` accept an optional actor/requestId/correlationId/source
  audit context (not just the fields given in the original minimal signature) because a mandatory
  audit entry needs an attributable actor; when a caller omits it, the audit entry is attributed to
  a `SYSTEM`/`inventory-domain` service identity rather than left unattributed. A caller that has
  real actor/request context (e.g. `domains/pos` handling an explicit cashier cancellation) should
  always pass it so the audit trail names the real actor.
- No command-level idempotency key exists yet for `reserveStock`/`issueInventory` beyond the
  database constraints and `releaseReservation`'s no-op path; a retried `issueInventory` call after
  a reservation was already consumed currently fails `NOT_FOUND` rather than being recognized as a
  duplicate. Revisit once `domains/pos`'s checkout orchestration defines its own idempotency-key
  contract.
- `receiveStock` records no unit cost/valuation (OD-107, same as the rest of this slice) and
  `adjustStock` applies immediately rather than through an approval workflow (INV-006's
  REQUESTED → APPROVED → POSTED states do not exist here) — `domains/wms` is responsible for
  gating who is allowed to call `adjustStock` (e.g. requiring a supervisor role) until that
  workflow exists for real.

## Acceptance tests

`domains/inventory/tests/inventory.integration.test.ts` uses an isolated PostgreSQL database (both
this domain's `0001_inventory.sql`/`0002_inventory_receive_adjust.sql` and `domains/audit`'s
`0001_audit_entry.sql` applied, since every command audits through `@pss/audit`) to verify:
`reserveStock` reserves exactly the requested qty when stock is sufficient; `reserveStock` is
all-or-nothing across lines — a short line leaves every other line's `qty_reserved` unchanged;
`releaseReservation` returns reserved qty to available; `issueInventory` after a reservation
decrements both on-hand and reserved and inserts a movement row; `receiveStock` increases on-hand
and inserts a `RECEIVE` movement; and `adjustStock` applies a positive correction, and rejects a
negative correction that would drop on-hand below what is already reserved.
