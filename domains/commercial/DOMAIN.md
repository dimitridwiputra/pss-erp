# Commercial domain

Status: COM-001/COM-002 minimal slice implemented — a flat, single-active-per-scope price list so `domains/pos` can resolve a sale price. No promo/discount engine, no approval workflow, no versioned effective-dating beyond immediate ACTIVE/EXPIRED transitions.

## Purpose

Resolve the sale price for a product/UOM within an organization's price-list scope, and let an authorized process activate a new price list for that scope.

## Owns

`core.price_list` and `core.price_list_item`: a price list is a flat set of per-product/UOM unit prices, scoped to `(organization_id, scope)`, with at most one `ACTIVE` list per scope at any time. No promo/discount rule, no approval workflow, no scheduled/future-dated activation — those remain COM-003..007 future work.

## Does not own

Product/UOM master data (`master-data` owns `core.product`; `product_id` here is an ID reference only, never a foreign key across domains). Customer-specific pricing, tiered/volume pricing, promotions, and price-list approval workflows are not implemented.

## Commands

`activatePriceList(pool, input)` creates a new price list with its items in one transaction and atomically supersedes (sets to `EXPIRED`) any price list currently `ACTIVE` for the same `(organizationId, scope)`, so the partial unique index never sees two `ACTIVE` rows for one scope. Rejects malformed input, including a `unitPrice` that is not a non-negative decimal string with at most 2 fraction digits, with `VALIDATION_FAILED`.

## Queries

`resolvePrice(pool, input)` finds the `ACTIVE` price list for `(organizationId, scope = priceListScope)` and the matching item for `(productId, uom)`. Throws `PRICE_NOT_FOUND` when no price list is active for the scope, or no item matches. Returns the unit price as a decimal string (never parsed to float), the price list ID, and its version.

## Events produced and consumed

None yet. `PRICE_LIST_ACTIVATED` has no registered payload schema in `packages/contracts` and is not published by `activatePriceList`; event publication is deferred until a schema is registered. OD-190 (docs/PRODUCT_PRD.md Appendix J/F, price list & stream grosir for POS, `pos.price_list_scope`) is the open decision tracking how POS's price-list scope should ultimately work.

## Tables

Migration `0001_commercial.sql` creates schema `core` (shared with `organization`, `master-data`, `principal-policy`, and `tax` per `scripts/check-database.mjs`'s `schemaOwners`, idempotently via `CREATE SCHEMA IF NOT EXISTS`):
- `core.price_list`: id, organization_id, scope, status (`DRAFT`/`PENDING_APPROVAL`/`SCHEDULED`/`ACTIVE`/`EXPIRED`), valid_from, version, timestamps. A partial unique index enforces at most one `ACTIVE` row per `(organization_id, scope)`.
- `core.price_list_item`: id, price_list_id (same-schema FK to `core.price_list`), product_id (plain UUID reference to `master-data`'s `core.product.id`, not a foreign key — cross-domain FKs are avoided per AGENTS.md §11.1), uom, unit_price (`numeric(18,2)`, non-negative), created_at. Unique on `(price_list_id, product_id, uom)`.

## Invariants

- At most one `ACTIVE` price list per `(organization_id, scope)`, enforced by a partial unique index, not application logic alone.
- `unit_price` is a non-negative decimal with at most 2 fraction digits, enforced by a database CHECK and by application-level validation before insert.
- Activating a price list is atomic: expiring the previous `ACTIVE` list and inserting the new list with its items happen in one transaction, so no window has zero or two `ACTIVE` lists visible to a concurrent reader outside the transaction.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` for `DomainError`, registered error codes, and `BusinessDateSchema`. No dependency on another domain's database; `product_id` is an ID reference by convention only.

## Open decisions

- OD-190: price list & stream grosir scope for POS (`pos.price_list_scope`) is still open; this slice treats `scope` as an opaque string supplied by the caller.
- `PRICE_LIST_ACTIVATED` event publication is deferred pending a registered payload schema in `packages/contracts`.
- Promo/discount engine, price-list approval workflow, and versioned effective-dated scheduling beyond immediate ACTIVE/EXPIRED are future work (COM-003..007).

## Acceptance tests

`domains/commercial/tests/commercial.integration.test.ts` uses an isolated PostgreSQL database (raw migration applied, real `pg.Pool`) to verify: `resolvePrice` throws `PRICE_NOT_FOUND` when no price list is active; `activatePriceList` then `resolvePrice` returns the activated unit price; activating a second price list for the same scope expires the first and `resolvePrice` returns the new price; and two activations for the same scope never leave more than one `ACTIVE` row.
