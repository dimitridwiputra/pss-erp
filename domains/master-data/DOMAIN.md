# master-data domain

Status: first real implementation. A minimal customer record plus a product/UOM/barcode read model
now exist to unblock `domains/pos`. Full product attribute set, pricing, and MDM merge/dedup
governance remain future work (Implementation Plan F1: CUS-001..007, PRD-001..004, MDM-001..006).

## Purpose

Own canonical customer master data and a read model of product identity (SKU, UOM, barcode) so
counter/POS and other domains never read another domain's tables directly for these facts.

## Owns

- `core.customer`: one row per customer, including exactly one system-provisioned walk-in customer
  per branch.
- `core.product`, `core.product_uom`, `core.product_barcode`: product identity, its unit-of-measure
  conversions, and barcode-to-UOM mapping. This is a read model slice only — the full product
  attribute set (pricing, principal ownership, hierarchy) is not implemented here.

## Does not own

Pricing, principal/commercial policy, inventory/stock, order capture, or any customer merge/tombstone
record. `is_walk_in`/`credit_disabled` are the only commercial-adjacent flags this slice carries;
credit limits and terms belong to `credit`/`commercial`.

## Commands

- `getOrCreateWalkInCustomer(pool, { organizationId, branchId })` — returns the branch's single
  walk-in customer (`Pelanggan Umum Grosir`, `credit_disabled = true`, `status = 'ACTIVE'`), creating
  it on first use. Concurrency-safe: a losing insert hits `customer_walk_in_per_branch_idx` and
  re-selects the winning row instead of failing.
- `createCustomer(pool, input)` — quick-registers a prospect/walk-up customer as `PENDING_REVIEW`
  with an auto-generated, collision-retried `code` (`CUS-<hex6>`). Always audited
  (`CUSTOMER_CREATED`); `phone`/`npwp` are classified `PERSONAL` in the audit changes per AGENTS.md
  §15. Does not implement CUS-003 duplicate-person detection, and nothing currently transitions a
  created customer out of `PENDING_REVIEW` — that review/approval workflow is future work.

## Queries

- `findProductByBarcode(pool, { organizationId, barcode })` — resolves a scanned barcode to its
  product and the UOM the barcode itself represents (not necessarily the product's base UOM).
- `searchProducts(pool, { organizationId, query, limit? })` — `ILIKE` match over `sku`/`name`
  (wildcards in the query text are escaped), default limit 20, capped at 100.

## Events produced and consumed

None are published yet. `CUSTOMER_CREATED` (PRD Appendix C.1, producer `master-data`, aggregate
`Customer`) is registered in the event catalog but has no payload schema in
`packages/contracts/src/events/index.ts`'s `eventSchemaRegistry`. `createCustomer` and
`getOrCreateWalkInCustomer` therefore only perform the `core.customer` insert and the audit entry —
event publication is deferred (see Open Decisions, OD-06).

## Tables

Migration `0001_master_data.sql` creates, in schema `core` (shared with `organization`,
`principal-policy`, `commercial`, `tax` per `scripts/check-database.mjs`'s `schemaOwners`):

- `core.customer` — canonical customer row; `UNIQUE (organization_id, code)`; a partial unique index
  (`customer_walk_in_per_branch_idx`) enforces at most one `is_walk_in` row per
  `(organization_id, branch_id)`.
- `core.product` — `UNIQUE (organization_id, sku)`.
- `core.product_uom` — FK to `product.id` (same migration file/schema); `UNIQUE (product_id, uom)`.
- `core.product_barcode` — FK to `product.id`; `UNIQUE (barcode)` globally.

## Invariants

- Exactly one walk-in customer per `(organization_id, branch_id)`, enforced by
  `customer_walk_in_per_branch_idx`, not application logic alone.
- `core.customer.code` is unique per organization; `core.product.sku` is unique per organization.
- A barcode identifies exactly one product **and** one UOM of that product
  (`product_barcode.barcode` is globally unique).
- Every `core.customer` mutation runs inside `withAuditedTransaction` — there is no unaudited write
  path in this domain.

## Dependencies

`@pss/contracts` (`DomainError`, error registry) and `@pss/audit` (`withAuditedTransaction`), both
via their public package barrels. No dependency on another business domain. No domain currently
depends on `master-data` in-repo; `domains/pos` (built separately) is the intended first consumer of
this application layer.

## Open decisions

- **OD-06**: `CUSTOMER_CREATED`'s payload schema is not yet registered in `eventSchemaRegistry`, so
  event publication is deferred pending product/ownership sign-off on the Appendix C.1 payload
  shape. Tracked against product ownership.
- CUS-003 (duplicate-person detection) and MDM-006 (merge/tombstone) are explicitly out of scope for
  this slice; `createCustomer` never flags or blocks a `POSSIBLE_DUPLICATE`.
- Full product attribute set, pricing, and principal-specific product policy (PRD-001..004) are not
  implemented; `core.product`/`core.product_uom`/`core.product_barcode` are a read model only. No
  ingestion/write path for product data exists yet in this domain.
- No `interfaces/http` or `interfaces/events` layer exists yet — this is an application-layer-only
  slice, consumed directly by other domains' application code (e.g. `domains/pos`).

## Acceptance tests

`domains/master-data/tests/master-data.integration.test.ts` — real PostgreSQL, with `0001_master_data.sql`
and `audit`'s `0001_audit_entry.sql` applied raw in `beforeAll`: `getOrCreateWalkInCustomer` is
idempotent and safe under two concurrent calls for the same branch; `createCustomer` writes exactly
one `audit.audit_entry` row for the new customer; `findProductByBarcode` returns the UOM row the
scanned barcode itself maps to; `searchProducts` matches partial SKU/name and returns nothing for a
non-matching query.
