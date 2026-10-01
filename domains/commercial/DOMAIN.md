# Commercial domain

Status: COM-001 implemented as a versioned price list — draft, edit, activate. No promo/discount
engine, no approval workflow, no scheduled future-dated activation (COM-003..007).

## Purpose

Own the sale price of a product in a unit, for a scope, from a specific business date. Resolve that
price for POS at checkout, and let an authorized process publish a new version of it.

## Owns

`core.price_list` and `core.price_list_item`: a price list is a set of per-product/unit prices
scoped to `(organization_id, scope)`, versioned, with at most one `ACTIVE` list per scope at a time.

## Does not own

Product identity and units (`master-data` owns `core.product`; `product_id` here is a plain UUID
reference, never a cross-domain foreign key), cost or stock (`inventory`), customer-specific or
tiered pricing, promotions, and the approval workflow COM-001 requires (MVP-OD-14).

## Commands

| Command | Note |
|---|---|
| `createDraftPriceList(pool, client, input)` | A DRAFT, optionally copying the version it will supersede so a change is three edited prices rather than a full retyping. |
| `setPriceListItem(pool, client, input)` | One product × unit × price, on a **DRAFT only**. An ACTIVE list is not editable: COM-001.BR02 and NC01. A price of zero or less is refused (COM-001 flow E1). |
| `activateDraftPriceList(pool, client, input)` | Publishes a DRAFT and expires the scope's previous ACTIVE list in the same transaction, so the partial unique index never sees two. A draft with no price is refused. |
| `activatePriceList(pool, client, input)` | Creates and activates in one call — the seed and `resolvePrice`'s tests use it. It is not the screen flow; the screens use the three commands above. Audited, and now takes a client. |

## Queries

| Query | Note |
|---|---|
| `resolvePrice(pool, input)` | The ACTIVE list for the scope and the item for `(productId, uom)`. `PRICE_NOT_FOUND` when either is missing. Returns a decimal string, never a parsed float. |
| `listPriceLists(pool, client, input)` | The versions of a scope, newest first, plus the scope's live `activePriceListId` so a screen can say what is in force. |
| `listPriceListItems(pool, client, input)` | One version's items, paginated and allow-list sorted. `productId` only — never a product name, because `core.product` is `master-data`'s table. |

## Events produced and consumed

None published. `PRICE_LIST_ACTIVATED` has no registered payload schema (OD-190 follows the same
path as `master-data`'s OD-06).

## Tables

`0001_commercial.sql` creates schema `core` (shared, see `schemaOwners`):

- `core.price_list`: `status` ∈ DRAFT / PENDING_APPROVAL / SCHEDULED / ACTIVE / EXPIRED,
  `valid_from`, `version`. A partial unique index enforces at most one ACTIVE row per
  `(organization_id, scope)`.
- `core.price_list_item`: `price_list_id` FK (same schema), `product_id` plain UUID, `uom`,
  `unit_price numeric(18,2)` non-negative. `UNIQUE (price_list_id, product_id, uom)`.

## Invariants

- At most one ACTIVE list per `(organization_id, scope)`, by partial unique index.
- `unit_price` is a non-negative decimal with at most 2 fraction digits — by database CHECK and by
  application validation before insert. It is never a float anywhere in the path.
- Activation is atomic: expiring the previous ACTIVE list and publishing the new one happen in one
  transaction, so no concurrent reader outside it sees zero or two ACTIVE lists.
- An ACTIVE list's prices are immutable. A change is always a new version.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` for `DomainError`, registered codes and `BusinessDateSchema`. No
dependency on another domain's database.

## Open decisions

- **MVP-OD-14**: COM-001 requires an approval step
  (`approval.price_list_activation.levels`, AC03 rejecting proposer = approver). The MVP activates a
  draft directly and audits the activation. Adding the step means a `DRAFT → PENDING_APPROVAL →
  ACTIVE` path and a new permission, and it is not built.
- OD-190: the price-list scope for POS (`pos.price_list_scope`) is open. `scope` is an opaque string
  the caller supplies; POS uses `KONTER` and this domain does not interpret it.
- `PRICE_LIST_ACTIVATED` publication is deferred pending a registered payload schema.
- COM-003..007 (promos, discounts, customer/tier pricing, scheduled activation) are future work.

## Acceptance tests

- `domains/commercial/tests/commercial.integration.test.ts` — real PostgreSQL: `resolvePrice` raises
  `PRICE_NOT_FOUND` with no active list; activation then resolution; a second activation expires the
  first; two activations never leave two ACTIVE rows; an edit to an ACTIVE list is refused while a
  draft accepts it; a zero price is refused; a draft with no item cannot be activated.
- `apps/api/tests/backoffice.integration.test.ts` — the HTTP surface, including that a scope the
  caller does not hold reads as `404 NOT_FOUND` rather than a list.
