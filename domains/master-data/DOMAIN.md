# master-data domain

Status: first real implementation. A minimal customer record plus a product/UOM/barcode read model
now exist to unblock `domains/pos`, along with the two tax classification fields TAX-001 asks for
(`customer.tax_treatment`, `product.tax_code`). Full product attribute set, pricing, and MDM
merge/dedup governance remain future work (Implementation Plan F1: CUS-001..007, PRD-001..004,
MDM-001..006).

## Purpose

Own canonical customer master data and a read model of product identity (SKU, UOM, barcode) so
counter/POS and other domains never read another domain's tables directly for these facts.

## Owns

- `core.customer`: one row per customer, including exactly one system-provisioned walk-in customer
  per branch, and `customer.tax_treatment` — the sales tax code applied to that customer
  (VAT_OUTPUT / EXEMPT / NON_VAT, or NULL for undetermined).
- `core.product`, `core.product_uom`, `core.product_barcode`: product identity, its unit-of-measure
  conversions, and barcode-to-UOM mapping. This is a read model slice only — the full product
  attribute set (pricing, principal ownership, hierarchy) is not implemented here — plus
  `product.tax_code`, the default sales tax code for lines of that product.

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
  with an auto-generated, collision-retried `code` (`CUS-<hex6>`) and an optional `taxTreatment`
  (`VAT_OUTPUT` / `EXEMPT` / `NON_VAT`; omitted means undetermined, not zero-rated). Always audited
  (`CUSTOMER_CREATED`); `phone`/`npwp` are classified `PERSONAL` in the audit changes per AGENTS.md
  §15, and `taxTreatment` is recorded as `INTERNAL`, as the value given or the literal `UNSET` so the
  trail says the field was considered and left unresolved. Does not implement CUS-003 duplicate-person
  detection, and nothing currently transitions a created customer out of `PENDING_REVIEW` — that
  review/approval workflow is future work.

## Queries

- `findProductByBarcode(pool, { organizationId, barcode })` — resolves a scanned barcode to its
  product and the UOM the barcode itself represents (not necessarily the product's base UOM).
- `searchProducts(pool, { organizationId, query, limit? })` — `ILIKE` match over `sku`/`name`
  (wildcards in the query text are escaped), default limit 20, capped at 100.
- `getCustomerTaxTreatment(pool, client, { customerId, organizationId })` — the customer's sales tax
  treatment, or `null` when none is recorded. `null` is a real answer, distinct from `NOT_FOUND`
  (unknown customer or one belonging to another organization), because `tax` refuses a taxable line
  in the `null` state rather than assuming a treatment. Accepts a `client` so a caller inside a
  transaction reads the customer it will bill.
- `getProductTaxCodes(pool, client, { productIds, organizationId })` — the default tax code of each
  requested product as a `Map`, batched (one query, not one per line) because an invoice is prepared
  inside a checkout transaction that already holds a pool client. Products that do not exist are
  absent from the map, which the caller treats the same as a stored `null`.

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
  `(organization_id, branch_id)`; `tax_treatment` is nullable with a CHECK over the three sales codes.
- `core.product` — `UNIQUE (organization_id, sku)`; `tax_code` is nullable with the same CHECK.
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
- `tax_treatment` and `tax_code` are nullable with **no database default**. A row written before
  migration `0002`, or by a caller that omitted the field, is NULL, which `tax` treats as unresolved
  and refuses rather than as zero-rated. A DEFAULT would silently decide tax liability for every
  existing row, which is a business decision no migration may make.

## Dependencies

`@pss/contracts` (`DomainError`, error registry) and `@pss/audit` (`withAuditedTransaction`), both
via their public package barrels. No dependency on another business domain. `domains/pos` and
`domains/invoicing` are the consumers: POS resolves a walk-in customer before checkout, and invoicing
reads a customer's treatment and a product's code through this package's public functions rather than
from `core.*` (AGENTS.md §3.1).

## Open decisions

- **OD-06**: `CUSTOMER_CREATED`'s payload schema is not yet registered in `eventSchemaRegistry`, so
  event publication is deferred pending product/ownership sign-off on the Appendix C.1 payload
  shape. Tracked against product ownership.
- **Nothing writes `product.tax_code` yet, so every taxable invoice is currently refused.** This
  domain still has no product ingestion path of any kind, so `core.product` rows arrive from outside
  it and every one has `tax_code IS NULL`; `domains/tax` then refuses to issue with
  `TAX_CODE_MISSING` (TAX-002.E1). That is the PRD's intended fail-closed behaviour rather than a
  silent zero-rate, but it does mean the tax path cannot be exercised in production until a product
  write path exists or a `setProductTaxCode` command is added. Recorded so it is not mistaken for a
  working feature.
- **No command changes a tax classification after creation.** `createCustomer` accepts
  `taxTreatment` once; there is no setter, so a customer created without one, and a POS walk-in
  customer, can never be given a treatment through this domain's API. TAX-001 treats "default kode
  pajak per customer" as master data with the usual amend lifecycle, so a setter is expected — it is
  simply not built here, and a stewarded UPDATE would bypass the audit trail.
- **Whether a POS walk-in counter sale should default to VAT_OUTPUT is a product decision, not an
  engineering one, and is not made here.** `getOrCreateWalkInCustomer` records no treatment, which
  means POS checkout to a walk-in customer is refused by `tax` until the treatment is set.
- CUS-003 (duplicate-person detection) and MDM-006 (merge/tombstone) are explicitly out of scope for
  this slice; `createCustomer` never flags or blocks a `POSSIBLE_DUPLICATE`.
- Full product attribute set, pricing, and principal-specific product policy (PRD-001..004) are not
  implemented; `core.product`/`core.product_uom`/`core.product_barcode` are a read model only. No
  ingestion/write path for product data exists yet in this domain.
- No `interfaces/http` or `interfaces/events` layer exists yet — this is an application-layer-only
  slice, consumed directly by other domains' application code (e.g. `domains/pos`).

## Acceptance tests

`domains/master-data/tests/master-data.integration.test.ts` — real PostgreSQL, with this domain's
migrations and the whole `audit` domain replayed in `beforeAll` (both, because the tax columns arrive
in `0002` and because a fixture that replays only `0001` is what made amending a shipped migration look
safe — MIG-RISK-AUD-001): `getOrCreateWalkInCustomer` is idempotent and safe under two concurrent
calls for the same branch; `createCustomer` writes exactly one `audit.audit_entry` row for the new
customer and keeps same-named customers in separate branches distinct; `findProductByBarcode` returns
the UOM row the scanned barcode itself maps to; `searchProducts` matches partial SKU/name and returns
nothing for a non-matching query; and the tax reads — a recorded treatment round-trips, a customer
created without one reads `null` rather than `NON_VAT`, a customer of another organization is
`NOT_FOUND`, and product codes come back in one batch with `null` for uncoded products and no entry at
all for another organization's.
