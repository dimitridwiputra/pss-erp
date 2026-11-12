# invoicing domain

Status: BIL-001/002 (prepare and issue a sales invoice) with TAX-002 tax resolution wired in. Draft /
print flow, due date/TOP basis, consolidation/grouping, external-origin import, correction after issue
and the faktur pajak handoff (TAX-004) remain future work — see "Open decisions".

## Purpose

Own the sales invoice: reserve a fiscal-style number per organization/year, record the invoice and
its lines, resolve the tax on each line through the `tax` domain, and transition the invoice from
PREPARED to ISSUED once the delivery is confirmed.

## Owns

- `Invoice` (header: number, status, subtotal, tax_total, total, invoice_date, tax_rounding_rule).
- `InvoiceLine` (product/uom/qty/unit_price/line_total per invoice, plus the tax snapshot:
  tax_code/tax_rate/tax_base/tax_rounding_rule/tax_amount).
- The per-organization-per-year invoice numbering sequence.
- The stored result of the `tax` domain's resolution on this document.

Explicitly NOT owned by this slice:
- The tax rules themselves. `resolveSalesTax` and `resolveSalesTaxOnSnapshot` are `@pss/tax`'s;
  invoicing supplies quantities and prices and stores what it is told (AGENTS.md §3.1).
- The customer's tax treatment and the product's default tax code. `@pss/master-data` owns those;
  invoicing reads them through `getCustomerTaxTreatment` / `getProductTaxCodes` and never from
  `core.*` directly.
- Consolidation/grouping of multiple delivery orders into one invoice (BIL-004) — out of scope.
- External-origin invoice import (BIL-005) — out of scope.
- Draft/print flow, due date/TOP basis, invoice cancellation before ISSUED (BIL-001, BIL-003) —
  out of scope.
- Correction after issue via credit note (STM CreditNote, TAX-002.AC02) — out of scope. The snapshot
  columns are what that feature would read, so it does not require re-resolving anything.

## Commands

- `prepareInvoice(pool, client, input)` — reserves the next invoice number for
  `(organizationId, currentJakartaYear)`, resolves each line's tax, inserts the invoice as `PREPARED`
  with its lines and the tax snapshot on each, and computes `subtotal`/`tax_total`/`total` via a
  server-side `SUM` (never JS arithmetic on money). Accepts an optional already-open `PoolClient` so a
  caller (e.g. `pos`'s own checkout transaction) can run it as part of a larger transaction; when
  omitted, the command manages its own transaction. Audited as `INVOICE_PREPARED`.

  `customerId` is **required**. A sale with no customer has no tax treatment, and defaulting one is
  the silently-zero-taxed invoice this command used to produce. `businessDate` is optional and
  defaults to today in Asia/Jakarta — a same-day sale is the ordinary case, so the default is that
  case rather than a rule; a backdated or future-dated invoice passes its own date and is taxed by it
  (TAX-001.BR01). `channel: 'POS'` additionally requires `branchId`, stored for `INVOICE_ISSUED`.
- `issueInvoice(pool, client, input)` — transitions a `PREPARED`/`DRAFT` invoice to `ISSUED`,
  recomputing every line to match only the delivered qty (see the line-removal rule below) and
  re-quantifying each line's tax from the snapshot the line already carries, never from the rate in
  force now (TAX-002.NC01). Sets `invoice_date`. Joins the caller's open transaction when `client` is
  given: POS pickup handover issues it in the same commit as the delivery and the stock issue
  (POS-010.R02). A `channel: 'POS'` invoice publishes `INVOICE_ISSUED` v1 in that transaction. Throws
  `DomainError('INVALID_STATE_TRANSITION')` if the invoice is not `PREPARED`/`DRAFT` (e.g. issuing
  twice), `NOT_FOUND` if the invoice does not exist, and `TAX_RATE_NOT_CONFIGURED` for a line whose
  tax snapshot is missing. Audited as `INVOICE_ISSUED`.

**Line-removal rule (decision recorded here):** in `issueInvoice`, a prepared line whose
`productId`+`uom` is absent from `deliveredLines`, or present with `qtyDelivered = "0"`, is **deleted**
from the invoice rather than kept as a zero-qty row. This is forced by the schema, not an arbitrary
style choice: `sales.invoice_line.qty` has `CHECK (qty > 0)`, so a zeroed line is not a
representable state. A partially delivered line has its `qty`/`line_total` reduced to the delivered
amount.

## Queries

None implemented in this slice.

## Events produced and consumed

Produced: `INVOICE_ISSUED` v1 (MVP_PLAN §5), through `appendOutboxEvent` in the
same transaction as the issue. It is built from the stored invoice, whose
`channel`, `customer_id` and `branch_id` are set by `prepareInvoice` (migration
`0002_invoice_event_facts.sql`); a POS invoice must carry its branch. Its
`taxAmount` is the invoice's snapshotted `tax_total`. Only the POS channel has a
v1 payload. Other invoices, and `INVOICE_PREPARED`, publish nothing yet.
`TAX_RATE_ACTIVATED` is not emitted from `tax` (`domains/tax/DOMAIN.md`).

## Tables

Schema `sales` (shared with `orders`, `credit`, `fulfillment`, `returns` per
`scripts/check-database.mjs`'s `schemaOwners`):

- `sales.invoice_number_sequence` — `(organization_id, year)` -> `last_value`.
- `sales.invoice` — header; `UNIQUE (organization_id, number)`; `tax_rounding_rule` records the scope
  that produced `tax_total` (migration `0002`).
- `sales.invoice_line` — lines; `FOREIGN KEY (invoice_id) REFERENCES sales.invoice (id)`; the
  `tax_code` / `tax_rate` / `tax_base` / `tax_rounding_rule` snapshot columns (migration `0002`).

## Invariants

- Invoice number is unique per organization (`UNIQUE (organization_id, number)`); reservation is
  atomic under concurrency (single `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statement, no
  read-then-write race). The year comes from the document's own `businessDate`, so a backdated invoice
  is numbered for the year it is dated in and cannot disagree with the date its rate was chosen by.
- Only `PREPARED`/`DRAFT` invoices can be issued; issuing an already-`ISSUED` (or `CANCELLED`) invoice
  is rejected with `INVALID_STATE_TRANSITION`.
- Issued invoices are immutable per **DEC-106** (`docs/PRODUCT_PRD.md`): no update/cancel command is
  provided in this slice, intentionally, since POS-012 cancel/return handling is deferred.
- `total = subtotal + tax_total`, and `total` **includes** tax. This changed: `total` previously
  equalled `subtotal` because `tax_total` was always 0.
- **An issued invoice's tax is a snapshot and is never recalculated (TAX-002.BR03/NC01).** Each line
  stores the code, rate, base and rounding rule it was priced under; a later change to the rate, the
  rounding rule, the customer's treatment or the product's code cannot alter the document.
- A line whose tax snapshot is NULL cannot be issued. It was written before tax resolution existed, its
  tax was never computed, and issuing it would publish exactly the zero-taxed invoice this change
  removed.
- Tax resolution, the inserts, the audit entry and the header totals share one transaction (ADR-0013,
  DB.R09). A resolution that cannot be made throws before the invoice number is reserved, so a
  refused invoice leaves neither a partial row nor a burned number.
- `line_total` and `tax_base` are both computed by PostgreSQL as `ROUND(qty * unit_price, 2)`, so the
  amount charged and the base the rate was applied to cannot disagree by a rounding.

## Dependencies

- `@pss/audit` (`withAuditedTransaction`) for the audited transaction boundary.
- `@pss/contracts` for `DomainError`, `BusinessDateSchema`.
- `@pss/platform` for `withConnection` (the one audited-transaction primitive, ADR-0013).
- `@pss/tax` for `calculateSalesTax` and `resolveSalesTaxOnSnapshot` — the tax rules.
- `@pss/master-data` for `getCustomerTaxTreatment` and `getProductTaxCodes` — the customer's and the
  product's tax classification.
- No cross-domain database access. No dependency on `orders`/`fulfillment` read models in this slice
  (the caller — `pos` — supplies `salesOrderId` and line data directly).

## Open decisions

- **The tax base is the line total because invoicing has no discount model.** TAX-002.BR01 defines the
  DPP as the net line amount *after* discount (COM-003). This domain takes the base as `qty *
  unit_price` and hands it to `tax`, which is correct only while no discount is applied to an invoice
  line. When COM-003 lands, `taxBase` must become the post-discount net amount; the column and the
  resolver input already exist for it, but nothing here computes a discount yet. **Unresolved and
  material** — a discounted line would currently be taxed on its pre-discount amount.
- **The POS counter flow currently depends on its seed data declaring `EXEMPT`.** POS-004 resolves a
  walk-in customer whose treatment is unset, and `tax` refuses an undetermined treatment, so
  `tests/integration/pos-checkout-flow.integration.test.ts` sets the walk-in customer's treatment and
  the product's code to `EXEMPT` in its fixture. That is a fixture choice, not a product decision: see
  `domains/master-data/DOMAIN.md`'s open decision on whether a walk-in counter sale should default to
  VAT_OUTPUT, which nobody has decided.
- **The tax base's own rounding is `ROUND(..., 2)`, chosen here rather than by `tax.rounding_rule`.**
  DB.R04 puts document amounts at `decimal(18,2)`, so rounding the base to money scale is the
  column's own rule, not a tax policy. `tax.rounding_rule` governs rounding of the *tax amount*. Worth
  confirming with Finance/Tax, since a rounding rule naming document-level scope would also want to
  govern this.
- `prepareInvoice` takes the customer as an input rather than resolving it from `sales_order_id`. The
  order already carries a `customer_id`, so a caller that knows the order could be spared passing it.
  Passing it explicitly keeps the command's contract in one place and lets a caller invoice a
  customer other than the order's (a legitimate correction case), at the cost of the two disagreeing.
  Not yet a decision anyone has been asked to make.
- Draft/print flow, due date/TOP basis, invoice cancellation before ISSUED (BIL-001, BIL-003),
  consolidation (BIL-004), external-origin import (BIL-005) and correction after issue (credit note)
  are all out of this slice.
- No `interfaces/http` layer — this is an application-layer-only domain, consumed by `domains/pos`.
- `INVOICE_PREPARED` / `INVOICE_ISSUED` outbox publication is deferred: no registered payload schema.

## Acceptance tests

`tests/invoicing.integration.test.ts` — `prepareInvoice` reserves a sequential number and computes
subtotal, tax and total for a VAT-taxable sale; concurrent `prepareInvoice` calls for the same
org+year never collide on the same number; `issueInvoice` transitions `PREPARED` -> `ISSUED` and
recomputes subtotal/tax/total to the delivered qty for a full and a partial delivery, removing an
undelivered line; `issueInvoice` throws `INVALID_STATE_TRANSITION` when called twice.

`tests/invoicing-tax.integration.test.ts` — the tax decision IDs, each against a real database:

- **TAX-RESOLVE-01** — a VAT_OUTPUT customer and product at an approved 11% rate produces
  `tax_total = 110000.00` on a `1000000.00` net, with `tax_code`/`tax_rate`/`tax_base`/
  `tax_rounding_rule` stored on the line; a half-sen result follows the configured mode (`DOWN` →
  `10999.99`), not a default.
- **TAX-RESOLVE-02** — an EXEMPT or NON_VAT customer with **no rate row and `tax.vat_output_rate`
  KOSONG** still prepares and issues, at `tax_total = 0.00`, with the customer's zero-rated code
  overriding the product's `VAT_OUTPUT`.
- **TAX-RESOLVE-03** — a VAT_OUTPUT customer with no applicable rate, with `tax.vat_output_rate`
  KOSONG, with `tax.rounding_rule` KOSONG, with a product that has no tax code, and with a customer
  that has no treatment: each is refused, and the first leaves no invoice row and no reserved number.
- **TAX-RESOLVE-04** — with an 11% rate ending and a 12% rate starting on 2026-04-01, an invoice dated
  2026-03-31 is taxed at 11% and one dated 2026-04-01 at 12%; a date after the last rate ended is
  refused rather than falling back.
- **TAX-RESOLVE-05** — after issuing, changing the customer's treatment, the product's code, the
  rounding rule and the rate leaves the stored code, rate, base and amount untouched; re-quantifying a
  *prepared* invoice after a rate change uses the snapshotted rate, not the one now in force; and a
  line with its snapshot cleared is refused rather than issued untaxed.