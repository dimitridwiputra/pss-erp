# master-data domain

Status: product master and customer list implemented (MDM-001..004). The full product attribute set,
customer merge governance, and duplicate-person detection are not.

## Purpose

Own canonical customer master data and the product master — identity, units, and barcodes — so POS,
`commercial`, `inventory` and the back office never read another domain's tables for these facts
(AGENTS.md §3.1).

## Owns

- `core.customer`: one row per customer, including exactly one system-provisioned walk-in customer
  per branch.
- `core.product`, `core.product_uom`, `core.product_barcode`: product identity, its unit-of-measure
  conversions, and barcode-to-UOM mapping.
- The fact that a product is `DRAFT` / `ACTIVE` / `INACTIVE`, and that its `order_capture` is `PSS`
  or `EXTERNAL`. Nothing else in the system decides whether a product may be sold.

## Does not own

Price (that is `commercial`'s `core.price_list_item`), stock and cost (`inventory`), principal
ownership and commercial policy, order capture, and any customer merge/tombstone record.
`is_walk_in`/`credit_disabled` are the only commercial-adjacent flags here; credit limits and terms
belong to `credit`/`commercial`.

## Commands

| Command | Note |
|---|---|
| `createProduct(pool, client, input)` | MDM-001. `status` defaults to `DRAFT`, so nothing is sellable before it is priced. The SKU is the product's identity and is never editable afterwards. |
| `updateProduct(pool, client, input)` | Carries `expectedVersion`; a mismatch is `STALE_DATA` rather than a silent overwrite. A no-op still writes its audit entry (ADR-0013 4b). |
| `addProductBarcode(pool, client, input)` | MDM-003. A barcode belongs to a **unit** (`uom`), because a case label is not a piece label. A duplicate is `DUPLICATE_CODE` on the `barcode` field. |
| `addProductUom(pool, client, input)` | MDM-003. The conversion factor is written once and never edited (`UOM_FACTOR_LOCKED`). |
| `createCustomer(pool, client, input)` | Quick-registers a prospect as `PENDING_REVIEW` with a collision-retried `code`. `phone`/`npwp` are `PERSONAL` in the audit changes (AGENTS.md §15). |
| `getOrCreateWalkInCustomer(pool, input)` | The branch's single walk-in customer, created on first use. Concurrency-safe: a losing insert re-selects the winning row. |

Every command takes `(pool, client, input)`: pass the transaction `client` to join a caller's
transaction, or `undefined` to let the command own one.

## Queries

| Query | Note |
|---|---|
| `getProduct(pool, client, input)` | One product with its units (base unit first) and each unit's barcode. Takes a client because the API reads the product back inside a command's transaction. |
| `getProductSaleUnits(pool, input)` | **Two arguments, deliberately.** MVP-OD-10, requested by the POS stream for its catalog pick. It never runs inside a caller's transaction, and a three-argument read here would silently take a body where a client is expected. |
| `listProducts(pool, client, input)` | Allow-listed filters and sorts only (`q`, `status`, `page`, `pageSize`, `sort` ∈ name/sku/createdAt). Wildcards in `q` are escaped, not honoured. |
| `getProductsByIds(pool, client, input)` | The SKU/name of ids a caller already holds, so a page of prices or stock rows is labelled with one extra request instead of one per row. |
| `searchProducts(pool, input)` | `ILIKE` over `sku`/`name`, capped at 100. |
| `findProductByBarcode(pool, input)` | Resolves a scanned barcode to its product **and the unit that barcode represents**. |
| `listCustomers(pool, client, input)` | The read-only Pelanggan list (MDM-004). |

## Events produced and consumed

None published. `CUSTOMER_CREATED` is in the event catalog but has no payload schema in
`eventSchemaRegistry`, so `createCustomer` writes the row and the audit entry only (OD-06).

## Tables

`0001_master_data.sql` creates schema `core` (shared per `scripts/check-database.mjs`'s
`schemaOwners`):

- `core.customer` — `UNIQUE (organization_id, code)`; a partial unique index
  (`customer_walk_in_per_branch_idx`) enforces at most one `is_walk_in` row per
  `(organization_id, branch_id)`.
- `core.product` — `UNIQUE (organization_id, sku)`.
- `core.product_uom` — FK to `product.id`; `UNIQUE (product_id, uom)`.
- `core.product_barcode` — FK to `product.id`; `UNIQUE (barcode)` **globally**, which is stronger than
  the per-organization rule in the brief and is kept on purpose: one scanned code must not mean two
  products in two organizations that later merge or are read through one terminal.

## Invariants

- A barcode identifies exactly one product **and** one unit of that product.
- `product.sku` is unique per organization; `customer.code` likewise.
- Exactly one walk-in customer per `(organization_id, branch_id)`, by index rather than by
  application logic alone.
- Every `core.customer` and `core.product*` mutation runs inside an audited transaction. There is no
  unaudited write path in this domain.

## Dependencies

`@pss/contracts` and `@pss/audit`, both through their public barrels. No dependency on another
business domain. `domains/pos` is the first consumer of the product reads.

## Open decisions

- **OD-06**: `CUSTOMER_CREATED`'s payload schema is unregistered, so publication is deferred.
- **MVP-OD-20 / MVP-OD-21**: no read permission is registered for the product or the customer, so
  `listProducts`, `getProduct` and `listCustomers` stand on the steward write grant
  `master_data.product.manage`. Identity has been asked to add `inventory.stock_card.view` and a
  customer read code.
- CUS-003 (duplicate-person detection) and MDM-006 (merge/tombstone) are not implemented;
  `createCustomer` never flags `POSSIBLE_DUPLICATE`.
- The full product attribute set (principal ownership, hierarchy) is not implemented.
- No `interfaces/http` or `interfaces/events` layer: the HTTP surface is
  `apps/api/src/backoffice-product.controller.ts` (MVP_PLAN §4), which composes this domain's reads
  with `inventory`'s for the price and stock screens.

## Acceptance tests

- `domains/master-data/tests/master-data.integration.test.ts` — real PostgreSQL: walk-in idempotence
  under two concurrent calls, one audit row per `createCustomer`, the unit a scanned barcode maps to,
  partial SKU/name search, `STALE_DATA` on a stale edit, `DUPLICATE_CODE` on a repeated barcode, and
  `getProductSaleUnits` ordering base unit first.
- `apps/api/tests/backoffice.integration.test.ts` — the HTTP surface: 39 cases over authentication,
  scope, pagination, unknown sort keys, and the audit trail for every mutation.
