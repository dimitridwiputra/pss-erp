# Inventory domain

Status: costing and inventory events implemented for the MVP demo. A per-`(warehouse, product)`
on-hand/reserved balance with a moving-average unit cost, an append-only costed
receive/issue/adjust movement ledger, and `INVENTORY_RECEIVED` / `INVENTORY_ISSUED` /
`INVENTORY_ADJUSTED` published in the same transaction as the movement. Lot/expiry tracking,
warehouse transfers, and partial/backorder reservation remain future work (INV-001..009).

## Purpose

Track how much of each product is on hand and reserved per warehouse, **what it is worth**, and record
what has moved out of that stock — so `domains/pos` can make FULL-only reservation and issue decisions,
and `domains/finance` can post Dr Persediaan / Cr Barang Diterima Belum Ditagih, Dr HPP / Cr
Persediaan, and the Selisih Persediaan lines, all against one audited source of truth.

## Owns

`inventory.stock_balance` (on-hand/reserved quantity and the moving-average unit cost, per
warehouse+product), `inventory.stock_reservation` (one row per reserved line, keyed by an external
reference), `inventory.stock_movement` (an append-only, **costed** ledger of receives, issues and
adjustments) and `inventory.stock_adjustment_reason` (the adjustment reason vocabulary). No other
domain writes these tables.

## Does not own

Purchasing/receiving (there is no `procurement` domain; MVP_PLAN §9 puts purchase orders and AP
invoices out of scope, so `receiveStock` is called directly and records what the caller states),
lot/expiry/serial tracking, warehouse transfers, price, or the checkout/order/fulfilment aggregate —
`reference_type`/`reference_id` are opaque to this domain and the caller owns what they mean. It does
not post anything to the General Ledger: that is `finance`'s job, driven by the events below.

## Commands

Every command takes an already-open `PoolClient` when a caller has one, so a POS checkout or a WMS
receipt can share one transaction across several domain calls; omitted, each opens its own audited
transaction the same way `withAuditedTransaction` does.

- `reserveStock(pool, client, input)` — reserves every line of `input.lines` for
  `(referenceType, referenceId)` in one all-or-nothing transaction (POS-005.BR02: FULL reservation
  only). Locks each balance row, checks `qty_on_hand - qty_reserved >= qty` in SQL, inserts one
  `ACTIVE` reservation per line, appends one `STOCK_RESERVED` audit entry. A short line throws
  `INSUFFICIENT_STOCK` with one field error per short line and rolls the whole thing back.
- `releaseReservation(pool, client, input)` — releases every `ACTIVE` reservation for a reference.
  Retry-safe: nothing `ACTIVE` left is a no-op (`{ releasedCount: 0 }`) that also writes no audit
  entry, because nothing was mutated.
- `issueInventory(pool, client, input)` — for each line, decrements **both** `qty_on_hand` and
  `qty_reserved` (the units are no longer promised to anyone), marks the matching `ACTIVE`
  reservation `CONSUMED`, values the movement at the balance's current average, and publishes
  `INVENTORY_ISSUED`. The qty issued may be less than the qty reserved (partial pickup, POS-010);
  reconciling the remainder is the caller's responsibility. A non-positive qty is refused
  (`VALIDATION_FAILED`): a negative issue would be a receipt nobody priced.
- `receiveStock(pool, client, input)` — increases on-hand and publishes `INVENTORY_RECEIVED`.
  `input.sourceType` is required (`GOODS_RECEIPT` | `WMS_RECEIPT`) because it is the whole of the
  event's `sourceType` and finance's posting rules switch on it; `input.referenceType`/
  `referenceId` are the ledger's own opaque pointer to the document, and the event's `sourceId`
  defaults to `referenceId`. Each line may carry a `unitCost`; omitting it (which is what
  `domains/wms` does) records an **unvalued** movement and publishes `unitCost: null`. A non-positive
  qty is refused. Audit action `INVENTORY_RECEIVED`.
- `adjustStock(pool, client, input)` — applies a signed `qtyDelta` per line, values it at the current
  average, records the line's `reasonCode` on the movement, and publishes `INVENTORY_ADJUSTED` with a
  signed `totalCostDelta`. A reason must be an **active code in
  `inventory.stock_adjustment_reason`**; an unknown code is a `VALIDATION_FAILED` naming the line, and
  it is checked before any quantity moves. A zero delta is refused. An adjustment may not push
  on-hand below what is already reserved (guarded in SQL, so it reports as a field error rather than a
  constraint violation). Audit action `INVENTORY_ADJUSTED`, carrying the first line's reason code and
  every line's reason **label** in `changes`.

### The costing rule

`applyMovingAverage` (`domain/rules/moving-average-cost.ts`) is pure — no database, no clock — and is
the single place a movement's valuation is decided. A caller reads the balance under `FOR UPDATE`, calls
it, and writes the quantity and the average back in one statement (`lockBalance` →
`applyMovingAverage` → `writeBalanceQuantity`, all in `application/stock-balance.ts`). The lock is
what makes two concurrent receipts for the same product safe: without it they would both average into
a balance one of them had already changed.

It says three things in its own types rather than collapsing them into a zero:

- a receipt with a cost re-averages quantity and value together (INV-003.AC01: 10 @ 100 then 10 @ 120
  → 110);
- a receipt **without** a cost leaves the average alone and records the movement unvalued;
- an issue or adjustment is valued at the average in effect *before* it, and is unvalued when the
  balance was never valued.

Two more cases it deliberately refuses to guess: a valued receipt landing on a balance that still
holds unvalued quantity values **neither** (that is a stock revaluation, MVP-OD-16), and a total is
multiplied out at full precision and rounded last, so the total finance posts is never recomputed from a
rounded unit cost (the residual is INV-003's own rounding case, its exception flow E1). Rounding is
4 places for a unit cost and 2 for a total, half away from zero, with `decimal.js` (MVP-OD-13 records
the PRD's `inventory.cost_precision` default of 6 against the column and payload's 4).

## Queries

- `getStockBalances(pool, client, { warehouseId })` — every product's on-hand/reserved for one
  warehouse, read-only. Kept for `domains/wms`'s WMS-002 activation reconciliation.
- `listStockBalances(pool, client, input)` — balances for one warehouse with `avgUnitCost` and
  `stockValue`, paginated, with allow-listed `sort` (`product`, `qtyOnHand`, `value`). `maxQty` is the
  low-stock filter and is **an input, not a constant**: the PRD registers no minimum-stock
  configuration key, so the threshold has to come from the caller (MVP-OD-17). `unvaluedOnly` selects
  the balances finance still has to value. `totalValue` is `null` when any balance in the set is
  unvalued, because a total that silently omitted unvalued stock would understate inventory and look
  like an answer. A `warehouseId` is required (MVP-OD-4).
- `listStockMovements(pool, client, input)` — the ledger newest first, filterable by warehouse,
  product, `movementType` and `reasonCode`, with the reason's Indonesian label joined from this
  domain's own reference table. `occurredAt` is the row's `created_at`, not the event's business
  date, so a backdated receipt shows both. Movement ids are uuid v7, so two rows written in the same
  millisecond still come back in the order they were written.
- `listAdjustmentReasons(pool, client?)` — the active reason codes with their Indonesian labels, for
  the Penyesuaian Stok form. No organization parameter, because the reference table has none
  (MVP-OD-15).

## Events produced and consumed

**Produced**, through `appendOutboxEvent` in the same transaction as the movement rows
(`infrastructure/events/inventory-movement-events.ts`):

| Event | Published by | Payload |
|---|---|---|
| `INVENTORY_RECEIVED` | `receiveStock` | §5 `GOODS_RECEIPT` \| `WMS_RECEIPT`, with the movement's `unitCost`/`totalCost` or `null` |
| `INVENTORY_ISSUED` | `issueInventory` | §5 `SALES_FULFILLMENT` — this is the path a POS sale's handover already calls, so a sale now produces a costed `INVENTORY_ISSUED` |
| `INVENTORY_ADJUSTED` | `adjustStock` | §5, with a signed `totalCostDelta` and the line's `reasonCode` |

Money is published at 2 places and quantity at 3, which is the contract's scale rather than the
column's; `unitCost` is therefore rounded from the ledger's 4 places down to 2 (MVP-OD-13). That is
safe because `totalCost` is what finance posts (MVP_PLAN §8), never `qty × unitCost`. A `null` cost
means **unvalued**, and is the signal for finance to route the movement to its exception queue rather
than post a zero (MVP_PLAN §5, AGENTS.md §3.7).

**Consumed**: none. `INVOICE_ISSUED` → `RecognizeCost` (INV-003's HPP recognition per invoice line) is
not built; the MVP's cost of goods sold comes from the issue at handover instead, which is what
MVP_PLAN §8's posting rule for `INVENTORY_ISSUED` describes.

## Tables

Migration `0001_inventory.sql` creates the `inventory` schema (owned solely by this domain per
`scripts/check-database.mjs`'s `schemaOwners`) with `stock_balance`, `stock_reservation` and
`stock_movement`. `0002_inventory_receive_adjust.sql` widens `stock_movement`'s `movement_type` CHECK
to allow `RECEIVE`. `0003_inventory_costing.sql` adds `stock_balance.avg_unit_cost numeric(18,4)`
and `stock_movement.unit_cost numeric(18,4)` / `total_cost numeric(18,2)`, all nullable and additive,
with non-negative CHECKs, and the two indexes the movement-history and low-stock queries serve.
`0004_inventory_adjustment_reason_reference.sql` adds `stock_adjustment_reason`, seeds the registered
Appendix F.3 codes with their Indonesian labels, and adds `stock_movement.reason_code` as a foreign
key to it plus a partial index for filtering by reason. No foreign key reaches another domain's
schema.

## Invariants

- `qty_reserved <= qty_on_hand` and `qty_reserved >= 0` always, enforced by table `CHECK`s rather than
  by application comparison — an `issueInventory` that would decrement more than is reserved fails the
  constraint and rolls back.
- Reservation is all-or-nothing per `reserveStock` call: every requested line is reserved, or none is.
- At most one `ACTIVE` reservation per `(reference_type, reference_id, product_id)`.
- A unit cost is never negative, on a balance or on a movement.
- An adjustment's reason is always an active code in this domain's reference table, and an adjustment
  of zero quantity is refused.
- The balance row is locked before its average is read, and the movement and its event commit together.
- A state mutation always leaves an audit entry (`runAuditedWork` rejects a callback that never audits);
  a genuine no-op (nothing `ACTIVE` to release) is the only path that skips both.

## Dependencies

PostgreSQL `pg`; `decimal.js` for money arithmetic; `@pss/contracts` for `DomainError`,
`DecimalStringSchema`, `parseEventForPublication`'s sibling `newEventId`, and `parseCommandInput`;
`@pss/audit` for the mandatory audited transaction and the audit-context shape; `@pss/platform` for
`appendOutboxEvent` and `withConnection`. No dependency on another domain's database schema.

## Open decisions

- **MVP-OD-4 / MVP-OD-12 (valuation unit):** the average is per warehouse × product × UoM, because
  `stock_balance` is unique per `(warehouse_id, product_id)`. The PRD's `inventory.valuation_unit`
  defaults to BRANCH, which would need a second balance key.
- **MVP-OD-13 (cost precision):** 4 places for a unit cost here; the PRD's
  `inventory.cost_precision` default is 6, and the §5 event payload declares `unitCost` as 2-place
  money. A request to widen the payload is with the stream that owns
  `packages/contracts/src/events/index.ts`.
- **MVP-OD-16 (revaluation):** a valued receipt onto a balance holding unvalued quantity values
  neither the movement nor the balance. The alternatives all invent a number.
- **MVP-OD-17 (low-stock threshold):** no configuration key exists for it, so `maxQty` is an input to
  `listStockBalances` and the caller supplies the value.
- **MVP-OD-19 (reason vocabulary):** the demo plan's four plain names are not in Appendix F.3; the
  registered codes are used, each carrying the label those names describe. F.3's "mandatory note" for
  `…_OTHER` has no field to write into.
- **INV-006 approval workflow:** `adjustStock` applies immediately as if already POSTED; the
  REQUESTED → APPROVED → POSTED states are not built. The caller's permission is
  `inventory.adjustment.request` (which `admin.demo` holds); `inventory.adjustment.approve` belongs to
  a role no demo user holds.
- No command-level idempotency key beyond the database constraints: a retried `issueInventory` after a
  reservation was consumed fails `NOT_FOUND` rather than being recognised as a duplicate. The HTTP
  layer's `runCommand` is where a retry is absorbed, so this only bites a non-HTTP caller.
- `INVENTORY_COST_RECOGNIZED` (INV-003) and cost of goods sold per invoice line are not built.

## Acceptance tests

`tests/inventory-moving-average-cost.test.ts` (unit, no database) covers the costing rule directly: the
re-average, the unvalued receipt, the issue and adjustment at the current average, the unvalued issue
and adjustment, the revaluation refusal, the weighted average, 4/2-place rounding, half-away-from-zero
at the boundary, and that no output is ever a negative zero.

`domains/inventory/tests/inventory.integration.test.ts` (real PostgreSQL) covers: reservation,
all-or-nothing, release, issue; a valued receipt re-averaging and publishing `INVENTORY_RECEIVED` with
its cost; an unvalued receipt leaving the average alone and publishing `unitCost: null`; a valued
receipt onto unvalued stock staying unvalued; **a rejected line leaving neither a movement nor an
outbox row, and rolling the balance row back**; a non-positive receipt or issue; a source type outside
the event contract; a sale carrying a cost through `INVENTORY_ISSUED`; an unvalued issue staying
unvalued; an unknown and a zero adjustment reason; a shortage publishing a signed negative cost delta
and a surplus a positive one; the reason label in the audit entry; the reference table's codes,
labels and the `…_OTHER` that F.3 requires; `listStockBalances` value, total, `unvaluedOnly`, the
caller-supplied low-stock threshold, pagination and organization isolation; `listStockMovements`
ordering, the joined reason label, filters and an unknown sort field.
