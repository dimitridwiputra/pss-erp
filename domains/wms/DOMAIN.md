# WMS domain (PSS Gudang)

Status: all fifteen WMS-0xx features (WMS-001..015) have a real implementation. Core loop:
location setup, activation reconciliation, receiving, putaway, allocation, pick, blind cycle
count, discrepancy reporting/resolution. Outbound: pack, stage, load. Support: unit/label
tracking, the physical<->financial reconciliation report, offline-queue replay, and a supervisor
dashboard query. See "Open decisions" for exactly what each of these simplifies relative to the
full PRD spec — nothing below is faked, but several features deliberately narrow scope where a
real dependency (a `fleet`/shipment aggregate, a projected `reporting` read model, lot/expiry
tracking) does not exist yet in this codebase.

## Purpose

Execute the physical work of a warehouse that has been switched to WMS management
(`wms_enabled = true`): locations/bins, physical on-hand quantity per location, and the
SCAN -> CONFIRM -> NEXT tasks (receive, putaway, pick, count) that move it — while leaving the
**financial** inventory ledger (`inventory.stock_balance`/`stock_movement`, owned by
`domains/inventory`) as the single source of truth for accounting. This domain never writes a
financial movement directly: every quantity change that must also move money goes through
`@pss/inventory`'s `receiveStock`/`issueInventory`/`adjustStock` in the same transaction.

## Owns

`wms.warehouse_config` (per-warehouse `wms_enabled` flag), `wms.warehouse_location` (zone -> aisle
-> rack -> bin hierarchy, plus RECEIVING/STAGING/QUARANTINE functional locations),
`wms.physical_stock` (this domain's own per-(location, product) on-hand/allocated quantity —
distinct from `inventory.stock_balance`'s per-warehouse financial quantity), `wms.warehouse_task`
(the generic RECEIVE/PUTAWAY/PICK/COUNT/PACK/STAGE/LOAD task table), `wms.stock_discrepancy_report`,
`wms.reconciliation_result` (one immutable row per (warehouse, business date)), `wms.warehouse_unit`
+ `wms.warehouse_unit_line` (pallets/cartons/koli and their contents), and `wms.label_print` (print/
reprint audit trail). No other domain writes these tables.

## Does not own

The financial inventory ledger, lot/expiry/serial tracking, purchase orders/procurement, or the
approval workflow behind a financial stock adjustment (`inventory`'s `StockAdjustment`, INV-006) —
this domain only requests one via `adjustStock`. It also does not own a real shipment/vehicle
aggregate — see `stagePackage`/`loadPackage` below and the open decisions for what stands in for
that.

## Commands

- `registerWarehouseLocation(pool, client, input)` — WMS-001: creates one location. A `code` must
  be unique per warehouse (`VALIDATION_FAILED` on duplicate); a `parentLocationId`, when given,
  must already exist in the same warehouse (`NOT_FOUND` otherwise). Audit action
  `WAREHOUSE_LOCATION_REGISTERED`.
- `setWarehouseLocationStatus(pool, client, input)` — WMS-001.BR02: flips a location between
  `ACTIVE`/`BLOCKED`. Blocking a location that still holds physical stock throws
  `LOCATION_NOT_EMPTY`. Audit action `WAREHOUSE_LOCATION_STATUS_CHANGED`.
- `activateWarehouse(pool, client, input)` — WMS-002 (simplified): compares, per product, Σ
  `wms.physical_stock.qty_on_hand` for the warehouse against `inventory`'s `qty_on_hand` (via
  `@pss/inventory`'s `getStockBalances` query — never reads `inventory`'s tables directly). Any
  mismatch throws `WMS_ACTIVATION_BLOCKED` with one field error per out-of-sync product; otherwise
  upserts `wms.warehouse_config.wms_enabled = true`. Audit action `WMS_ENABLED_CHANGED`.
- `receiveGoods(pool, client, input)` — WMS-003 (no-PO simplification, OD-136): resolves the
  scanned `locationCode` to a location, validating it is an `ACTIVE` `RECEIVING` location
  (`NOT_FOUND`/`LOCATION_INVALID`/`LOCATION_UNAVAILABLE` otherwise), increases `wms.physical_stock`
  there, records one `COMPLETED` `RECEIVE` `WarehouseTask` and one `CREATED` `PUTAWAY`
  `WarehouseTask` per line, and calls `@pss/inventory`'s `receiveStock` in the same transaction to
  post the financial receipt. Audit action `GOODS_RECEIVED_PHYSICAL`.
- `putawayStock(pool, client, input)` — WMS-004: confirms a `PUTAWAY` task, moving physical stock
  from the task's `location_id` to a scanned `toLocationCode` (a location *code*, resolved to its
  id server-side — the same convention `confirmPickTask` uses, since a code is what a handheld
  scanner actually reads off a location's label). An unrecognized code throws `NOT_FOUND`. Never
  touches the financial balance (WMS-004.BR01). Guards: task must be
  `CREATED`/`ASSIGNED`/`IN_PROGRESS` (`INVALID_STATE_TRANSITION`), `qtyConfirmed` cannot exceed the
  task's expected qty (`VALIDATION_FAILED`), the source location must have enough unallocated
  physical stock (`INSUFFICIENT_STOCK`), and the destination must be `ACTIVE`
  (`LOCATION_UNAVAILABLE`). Audit action `PUTAWAY_COMPLETED`.
- `allocatePickTask(pool, client, input)` — WMS-005 (simplified FIFO-by-location, no FEFO/lot):
  for each requested line, walks `ACTIVE` non-`QUARANTINE` locations holding the product (ordered
  by location `code`) and allocates until the qty is met or stock runs out, incrementing
  `qty_allocated` and creating one `CREATED` `PICK` `WarehouseTask` per (location, qty) claimed.
  Lines that cannot be fully allocated come back in `shortLines` rather than throwing (mirrors
  `ALLOCATION_SHORT`). WMS-005.R01 idempotency: if `PICK` tasks already exist for
  `(referenceType, referenceId)`, this is a no-op (`{ taskIds: [], shortLines: [] }`), checked
  before opening the audited transaction the same way `@pss/inventory`'s `releaseReservation` is.
  Audit action `ALLOCATION_COMPLETED` or `ALLOCATION_SHORT`.
- `getNextWarehouseTask(pool, input)` — WMS-006 "Tugas Berikutnya": query. Returns the oldest open
  task of the given `type` for the warehouse that is unassigned or already assigned to the caller,
  assigning it (`CREATED` -> `ASSIGNED`) on first fetch. `null` when there is none.
- `confirmPickTask(pool, client, input)` — WMS-006: SCAN -> CONFIRM -> NEXT. A scanned location
  code or product that does not match the task throws `SCAN_MISMATCH` *before* any state change
  (WMS-000.R02). `qtyConfirmed` cannot exceed the task's qty (`VALIDATION_FAILED`); a short pick
  (`qtyConfirmed` < expected) requires `shortReasonCode` (`VALIDATION_FAILED` otherwise). On
  success, decrements `wms.physical_stock` (on-hand and allocated) and calls `@pss/inventory`'s
  `issueInventory` to post the financial dispatch — see the command's own docstring for the
  precondition this depends on (an existing reservation from whoever released the fulfillment).
  Audit action `PICK_CONFIRMED` or `PICK_COMPLETED_SHORT`.
- `submitCycleCount(pool, client, input)` — WMS-010 (blind count): never returns the system qty or
  signed variance to the caller (WMS-010.BR01/NC01) — only whether a variance was detected. Does
  not overwrite `wms.physical_stock` itself (that would skip the review step); a variance instead
  opens a `stock_discrepancy_report` (`EXCESS`/`MISSING`) for `resolveStockDiscrepancy` to apply.
  Audit action `CYCLE_COUNT_SUBMITTED`.
- `reportStockDiscrepancy(pool, client, input)` — WMS-011 "Laporkan Masalah": records a
  `DAMAGED`/`MISSING`/`EXCESS`/`WRONG_LOCATION` exception. A `DAMAGED` report with no
  `evidenceMediaIds` throws `EVIDENCE_PHOTO_REQUIRED` (WMS-011.BR02). Never changes the financial
  balance itself (WMS-011.BR01). Audit action `STOCK_DISCREPANCY_REPORTED`.
- `resolveStockDiscrepancy(pool, client, input)` — the P0 stand-in for INV-006's full approval
  workflow: `ADJUST` posts the correction immediately (updates `wms.physical_stock` and calls
  `@pss/inventory`'s `adjustStock` in the same transaction, guarded so physical on-hand can never
  drop below what is already allocated) or `REJECT`s with no further state change. A
  `WRONG_LOCATION` report cannot be `ADJUST`ed (`VALIDATION_FAILED`) — moving stock belongs to
  `putawayStock`. Audit action `STOCK_DISCREPANCY_ADJUSTED` or `STOCK_DISCREPANCY_REJECTED`.
- `createWarehouseUnit`/`addWarehouseUnitLine`/`printLabel(pool, client, input)` — WMS-012
  (simplified): a physical unit (pallet/carton/koli) gets a unique, business-data-free `code`
  (WMS-012.BR01); `addWarehouseUnitLine` appends a scanned item to an `ACTIVE` unit found by that
  code (`NOT_FOUND` if unknown, `INVALID_STATE_TRANSITION` if already `CLOSED`); `printLabel`
  records every print/reprint against a location or unit and returns the next `copyNumber` so the
  caller can render "SALINAN" on anything after the first (WMS-012.R02). No actual PDF/QR image
  rendering exists — see open decisions. Audit actions `WAREHOUSE_UNIT_CREATED`,
  `WAREHOUSE_UNIT_LINE_ADDED`, `LABEL_PRINTED`/`LABEL_REPRINTED`.
- `completePacking(pool, client, input)` — WMS-007 "Selesai Pack": closes packing for one
  `(referenceType, referenceId)`. WMS-007.BR01 requires Σ koli contents to equal Σ picked qty for
  that reference; a mismatch (including zero koli at all) throws `PACK_QTY_MISMATCH` rather than
  allowing an incomplete pack through. Marks every `ACTIVE` unit for the reference `CLOSED` and
  records one `COMPLETED` `PACK` task. Audit action `PACK_COMPLETED`.
- `stagePackage(pool, client, input)` — WMS-008: scans one koli into a `STAGING`-type location by
  its code. When every koli for that unit's reference has been staged, also records a `COMPLETED`
  `STAGE` task — the caller (`fulfillment`, not built here) is expected to react by moving the FR
  to READY (WMS-008.NC02: WMS never changes the FR directly). Audit actions `PACKAGE_STAGED`,
  `STAGE_COMPLETED`.
- `loadPackage(pool, client, input)` — WMS-009: scans one koli onto a free-text `vehicleCode`
  (license plate or similar — no `fleet` vehicle registry exists to validate against). Requires the
  koli to already be staged (`INVALID_STATE_TRANSITION` otherwise) and rejects loading it twice.
  When every koli staged in the same lane has been loaded, also records a `COMPLETED` `LOAD` task
  scoped to that lane (see open decisions on why a lane stands in for "shipment"). Audit actions
  `PACKAGE_LOADED`, `LOAD_COMPLETED`.
- `runReconciliation`/`getReconciliationResult(pool, ..., input)` — WMS-013 (REQ-130, simplified):
  compares Σ `wms.physical_stock` against `inventory`'s financial balance per product for one
  warehouse and snapshots the result. Idempotent per `(warehouseId, businessDate)` — a second run
  for an already-reconciled date returns the original, immutable result rather than recomputing.
  Comparison key is (warehouse, product) only, not the full (warehouse, SKU, lot, condition)
  WMS-013.BR01 specifies (see open decisions). Audit action `WMS_RECONCILIATION_COMPLETED`.
- `syncOfflineConfirmations(pool, input)` — WMS-014: replays a batch of `PICK`/`PUTAWAY`
  confirmations a handheld device queued while offline, each through the exact same
  `confirmPickTask`/`putawayStock` guards as an online call (WMS-014.BR02 — the server stays the
  authority; a queued result can still be rejected). A task already in a terminal status is treated
  as already-synced (idempotent resubmit-safe); any other failure (a stale scan, a cancelled task)
  is reported per-item as `NEEDS_REVIEW` rather than aborting the batch. Every replayed confirmation
  is audited with `source: 'OFFLINE'` regardless of what the caller passed (WMS-014.R02) — this
  required widening `@pss/audit`'s `source` enum (and its DB `CHECK`) to add `OFFLINE`/`PAPER`,
  since neither existed before this feature.
- `getWarehouseDashboard(pool, input)` — WMS-015 (simplified): read-only aggregation of task counts
  by (type, status), short-today count, and discrepancy/cycle-count pending-review counts for one
  warehouse. See open decisions for why this deliberately does not follow WMS-015.NC01's "never
  compute from live transaction tables" rule yet.

Every mutating command accepts an already-open `PoolClient` so a caller can share one transaction
across multiple domain calls (e.g. `receiveGoods` calling `@pss/inventory`'s `receiveStock`); when
`client` is omitted each command opens its own transaction.

## Queries

`getNextWarehouseTask`, `getReconciliationResult`, `getWarehouseDashboard` (all above). The BFF
surface described in the PRD (`GET /gudang/tugas-berikutnya`, `GET /supervisor/gudang`, etc.) is
built at the `apps/api` controller layer (`apps/api/src/wms.controller.ts`), thin wrappers over
these.

## Events produced and consumed

None published to the outbox yet — every command above only appends an audit entry (`@pss/audit`),
none call `appendOutboxEvent`. The canonical event names referenced in this file's command docs are
used as audit `action` values only in this slice; wiring them to the outbox is future work once a
real consumer needs them (matching how `domains/inventory`'s `INVENTORY_ISSUED` is documented). This
is also why `getWarehouseDashboard` reads this domain's own tables directly instead of a projected
`reporting` read model — see open decisions.

## Tables

Migration `0001_wms.sql` creates the `wms` schema (owned solely by this domain per
`scripts/check-database.mjs`'s `schemaOwners`) with `warehouse_config`, `warehouse_location`
(self-referencing `parent_location_id`, unique `(warehouse_id, code)`), `physical_stock` (unique
per `(location_id, product_id)`, `qty_allocated <= qty_on_hand`, both `>= 0`), `warehouse_task`
(generic, one row per SCAN -> CONFIRM -> NEXT unit of work), and `stock_discrepancy_report`.
Migration `0002_wms_reconciliation_and_units.sql` adds `reconciliation_result` (unique per
`(warehouse_id, business_date)`), `warehouse_unit` + `warehouse_unit_line`, and `label_print`.
Migration `0003_wms_pack_stage_load.sql` widens `warehouse_task.type` to add `PACK`/`STAGE`/`LOAD`
and adds `staged_location_id`/`loaded_vehicle_code`/`loaded_at` to `warehouse_unit`. No foreign key
reaches another domain's schema — `warehouse_id`/`product_id`/`organization_id` are opaque UUIDs,
exactly like `inventory.stock_movement`'s reference columns.

## Invariants

- `physical_stock.qty_allocated <= qty_on_hand` always (table `CHECK`), so a `PICK` task can never
  claim more than is physically present.
- A scan mismatch never changes task state (WMS-000.R02) — checked and thrown before any `UPDATE`
  in `confirmPickTask`.
- A blind counter's response never carries the system qty or signed variance (WMS-010.BR01/NC01).
- A `stock_discrepancy_report` changes the financial balance only once `ADJUSTED`, never at
  `REPORTED` time (WMS-011.BR01).
- Every mutation has an audit entry; commands with a legitimate no-mutation no-op path
  (`allocatePickTask`'s idempotent replay) manage their own transaction directly instead of using
  the shared `withConnection` helper, exactly like `@pss/inventory`'s `releaseReservation`.
- A location is always addressed by its `code` at every command boundary a handheld operator
  reaches (`receiveGoods`, `putawayStock`, `confirmPickTask`, `submitCycleCount`,
  `reportStockDiscrepancy`) — a code is what a scanner reads off a location's label, an id is not.
  `location_id` stays purely an internal relational key; `registerWarehouseLocation`/
  `setWarehouseLocationStatus` are the only commands that take/return an id directly, since those
  are back-office management actions, not scans.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` for `DomainError`/registered codes
(`LOCATION_INVALID`/`LOCATION_UNAVAILABLE`/`LOCATION_NOT_EMPTY`/`SCAN_MISMATCH`/
`EVIDENCE_PHOTO_REQUIRED`/`WMS_ACTIVATION_BLOCKED`/`INSUFFICIENT_STOCK`/`VALIDATION_FAILED`/
`NOT_FOUND`/`PACK_QTY_MISMATCH`/`INVALID_STATE_TRANSITION`); `@pss/audit` for the mandatory audit
boundary (including its `OFFLINE`/`PAPER` source values, added for WMS-014); `@pss/inventory` for
`receiveStock`/`issueInventory`/`adjustStock`/`getStockBalances` — the only way this domain ever
touches the financial ledger. No dependency on a `fleet` package — Pack/Stage/Load treat vehicle
and lane identifiers as opaque strings/codes rather than calling into a shipment domain (see open
decisions).

## Open decisions

- Lot/expiry/serial tracking does not exist on `wms.physical_stock` — WMS-005 allocates
  FIFO-by-location-code as a documented stand-in for FEFO, and WMS-002's activation reconciliation
  compares per-product totals only, not per-(SKU, lot, condition) as the full spec requires.
- Stock *condition* (SELLABLE/DAMAGED/QUARANTINE) is not a first-class column — a `QUARANTINE`
  location type is the only condition signal this slice has. WMS-004.BR02 ("damaged goods can only
  go to a QUARANTINE location") and WMS-011.R02 ("physically move damaged goods to QUARANTINE")
  are therefore not enforced automatically; an operator must call `putawayStock` to move damaged
  goods there themselves.
- `confirmPickTask` depends on an inventory reservation the caller made earlier against the same
  `referenceId` (see its docstring) — this domain never creates that reservation itself, since
  WMS-005 allocation is conceptually triggered by `FULFILLMENT_RELEASED`, which only happens after
  the releasing domain already reserved. Nothing in this codebase wires that trigger yet (no
  `fleet`/dispatch integration, and `domains/pos`'s existing, already-tested pickup-handover flow
  is intentionally left untouched by this slice — see below).
- `submitCycleCount`'s recount-on-large-variance (WMS-010.BR02) and supervisor review
  (WMS-010.BR03/SOD-05) are not implemented — every variance goes straight to a
  `stock_discrepancy_report` for `resolveStockDiscrepancy`, with no distinction by variance size
  and no enforced different-person-recounts rule.
- `receiveGoods` records no unit cost/valuation, exactly like `@pss/inventory`'s `receiveStock`
  (OD-107 remains open).
- WMS-005/006's device-level idempotency key (WMS-005.R01/WMS-006's "Key perangkat + task.version")
  is only partially implemented: `allocatePickTask`'s reference-based idempotency covers replay of
  the whole allocation, but per-scan device idempotency at the controller/HTTP layer does not exist
  yet (no controller layer exists for this domain at all in this slice).
- Whether/how `domains/pos`'s `confirmPosPickupHandover` should eventually route through WMS pick
  tasks when a warehouse is `wms_enabled` is an explicit, deliberately deferred integration point —
  not implemented in this pass, to avoid touching already-tested POS code.
- No `fleet` domain exists. WMS-008/009's real spec reads a `fleet` shipment/route-stop aggregate to
  know "which koli belong on this vehicle"; this slice instead uses the staging lane a koli was
  placed in as the grouping WMS itself can observe (a truck backs up to a specific lane, so the lane
  <-> vehicle correlation holds at load time), and `vehicleCode` is recorded as free text with no
  registry to validate it against. A real `fleet` domain, when built, is free to layer real
  shipment-level grouping on top without WMS needing to change.
- WMS-012 has no actual QR/PDF label rendering — `printLabel` only records the print/reprint event
  and returns a copy number; generating and serving an actual label image/PDF is deferred (no
  `platform.documents` renderer integration yet).
- `getWarehouseDashboard` deliberately violates WMS-015.NC01 ("never compute from live transaction
  tables") — it queries `wms.warehouse_task`/`wms.stock_discrepancy_report` directly rather than
  through a projected `domains/reporting` read model, because no WMS command publishes outbox
  events yet (see "Events produced and consumed") and standing up a full outbox -> queue ->
  reporting-projector pipeline is not justified for a single P2 read-only view without real
  query-load data. `asOf` is simply "now" (a live query has no projection lag) — stricter freshness
  than the spec anticipates, not looser. "Petugas aktif" (active-operator presence) and "FR
  menunggu" (fulfillment requests waiting) are also not implemented — no session/presence tracking
  or fulfillment-request integration exists. "Tugas macet" (stuck-task detection) is not
  implemented either — the read model has no notion of how long a task has sat `ASSIGNED`.
- `runReconciliation`'s comparison key is (warehouse, product) only, not the full
  (warehouse, SKU, lot, condition) WMS-013.BR01 specifies — the same lot/condition gap
  `activateWarehouse` already has. Opening a `Q-INVENTORY_VARIANCE` queue item for a detected
  variance is deferred — no queue/exception-management infrastructure exists yet to open it into.
- `syncOfflineConfirmations` only replays `PICK`/`PUTAWAY` confirmations — WMS-014's "cetak picking
  list darurat" (emergency printed picking list) and "Input Hasil Manual" (manual paper-result
  re-entry) alternate flow are not built as dedicated commands; a supervisor can still achieve the
  same audit outcome by calling `confirmPickTask`/`putawayStock` directly with `source: 'PAPER'`,
  but no print-list query or dedicated manual-entry endpoint exists yet. New allocations while
  offline are correctly impossible (WMS-014.NC01) since `allocatePickTask` is not part of the
  offline queue at all.

## Acceptance tests

`domains/wms/tests/wms.integration.test.ts` uses an isolated PostgreSQL database (this domain's
three migrations, `domains/inventory`'s two migrations, and `domains/audit`'s two migrations all
applied) to verify, across 26 tests: location registration and its duplicate-code/missing-parent
guards; blocking a location that holds stock is rejected; warehouse activation is blocked on a
physical/financial mismatch and succeeds once they match; receiving goods increases physical
stock, posts the financial receipt, and creates a putaway task; putaway moves physical stock
between locations without changing the financial balance; allocation claims physical stock across
locations (and is a no-op on replay); a pick with a mismatched scan is rejected without changing
task state, while a correct pick completes and posts the financial issue; a blind cycle count
opens a discrepancy report on variance without ever exposing the system qty; resolving a
discrepancy report applies the correction (or rejects it) exactly once; reconciliation detects a
variance, is idempotent per (warehouse, date), and returns immutable results; a warehouse unit can
be created, scanned into, and reprinted with an incrementing copy number; a full pick -> pack ->
stage -> load walk completes end to end, rejecting a packing-qty mismatch, staging before packing,
and loading before staging or twice; the dashboard aggregates task counts, short-today, and
pending-review counts for one warehouse; and an offline-queued pick confirmation replays with
`source: 'OFFLINE'`, is idempotent on resubmit, and reports a scan mismatch as `NEEDS_REVIEW`
without aborting the batch.
