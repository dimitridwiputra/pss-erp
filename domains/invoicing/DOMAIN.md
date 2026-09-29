# invoicing domain

Status: first real slice implemented (narrow). This covers only what `pos`
needs to prepare an invoice number at checkout and issue the invoice once
goods are handed over. BIL-001..005 and TAX-001..005 (draft/print, due date,
consolidation/grouping, external-origin import, real PPN computation) remain
future work — see "Open decisions" below.

## Purpose

Own the sales invoice: reserve a fiscal-style number per organization/year,
record the invoice and its lines, and transition the invoice from PREPARED to
ISSUED once the delivery is confirmed (POS-005, BIL-001 narrowed).

## Owns

- `Invoice` (header: number, status, subtotal, tax_total, total, invoice_date).
- `InvoiceLine` (product/uom/qty/unit_price/line_total per invoice).
- The per-organization-per-year invoice numbering sequence.

Explicitly NOT owned by this slice (tracked as gaps, not silent shortcuts):
- PPN/tax computation. `tax_total` is hardcoded `0` on every invoice; the
  `tax` domain does not exist yet. Tracked as **OD-112** (PSS PKP status &
  applicable rate, `docs/PRODUCT_PRD.md`). `assertTaxConfigured()` in
  `src/application/prepare-invoice.ts` is a documented no-op stub for the
  future `INVOICE_BLOCKED` gate (POS-005 E2, TAX-001.AC02) — it always passes
  today and must be wired to a real `tax` domain check once TAX-001 ships.
- Consolidation/grouping of multiple delivery orders into one invoice
  (BIL-004) — out of scope.
- External-origin invoice import (BIL-005) — out of scope.
- Draft/print flow, due date/TOP basis, invoice cancellation before ISSUED
  (BIL-001, BIL-003) — out of scope.

## Commands

- `prepareInvoice(pool, client, input)` — reserves the next invoice number for
  `(organizationId, currentJakartaYear)`, inserts the invoice as `PREPARED`
  with `tax_total = 0`, inserts its lines, and computes `subtotal`/`total` via
  a server-side `SUM` over the lines (never JS arithmetic on money). Accepts
  an optional already-open `PoolClient` so a caller (e.g. `pos`'s own checkout
  transaction) can run it as part of a larger transaction; when omitted, the
  command manages its own transaction. Audited as `INVOICE_PREPARED`.
- `issueInvoice(pool, input)` — transitions a `PREPARED`/`DRAFT` invoice to
  `ISSUED`, recomputing every line to match only the delivered qty (see the
  line-removal rule below), and sets `invoice_date`. Always manages its own
  transaction. Throws `DomainError('INVALID_STATE_TRANSITION')` if the
  invoice is not `PREPARED`/`DRAFT` (e.g. issuing twice), and `NOT_FOUND` if
  the invoice does not exist. Audited as `INVOICE_ISSUED`.

**Line-removal rule (decision recorded here):** in `issueInvoice`, a prepared
line whose `productId`+`uom` is absent from `deliveredLines`, or present with
`qtyDelivered = "0"`, is **deleted** from the invoice rather than kept as a
zero-qty row. This is forced by the schema, not an arbitrary style choice:
`sales.invoice_line.qty` has `CHECK (qty > 0)`, so a zeroed line is not a
representable state. A partially delivered line has its `qty`/`line_total`
reduced to the delivered amount.

## Queries

None implemented in this slice.

## Events produced and consumed

None implemented in this slice. `INVOICE_PREPARED`/`INVOICE_ISSUED` event
publication (outbox) is deferred — callers observe results via command return
values only for now.

## Tables

Schema `sales` (shared with `orders`, `credit`, `fulfillment`, `returns` per
`scripts/check-database.mjs`'s `schemaOwners`):

- `sales.invoice_number_sequence` — `(organization_id, year)` -> `last_value`.
- `sales.invoice` — header; `UNIQUE (organization_id, number)`.
- `sales.invoice_line` — lines; `FOREIGN KEY (invoice_id) REFERENCES sales.invoice (id)`.

## Invariants

- Invoice number is unique per organization (`UNIQUE (organization_id, number)`);
  reservation is atomic under concurrency (single `INSERT ... ON CONFLICT ...
  DO UPDATE ... RETURNING` statement, no read-then-write race).
- Only `PREPARED`/`DRAFT` invoices can be issued; issuing an already-`ISSUED`
  (or `CANCELLED`) invoice is rejected with `INVALID_STATE_TRANSITION`.
- Issued invoices are immutable per **DEC-106** (`docs/PRODUCT_PRD.md`): no
  update/cancel command is provided in this slice, intentionally, since
  POS-012 cancel/return handling is deferred. Correction-after-issue (credit
  note) is out of scope here.
- `tax_total` is always `0` (see OD-112 above) — this is a visible, documented
  gap, not a silent shortcut.

## Dependencies

- `@pss/audit` (`withAuditedTransaction`/`runAuditedWork`) for the audited
  transaction boundary.
- `@pss/contracts` for `DomainError`, `BusinessDateSchema`.
- No cross-domain database access; no dependency on `orders`/`fulfillment`
  read models in this slice (the caller — `pos` — supplies `salesOrderId` and
  line data directly).

## Open decisions

- **OD-112** (`docs/PRODUCT_PRD.md`): PSS PKP status and the applicable PPN
  rate. Blocks real tax computation; until resolved, every invoice is stored
  with `tax_total = 0` and `assertTaxConfigured()` stays a no-op stub.
- Line-removal-on-partial/no-delivery: resolved above (delete, not zero) —
  forced by the `qty > 0` check constraint; recorded here so a future
  consolidation/return feature does not silently change this behavior.

## Acceptance tests

See `tests/invoicing.integration.test.ts`:
- `prepareInvoice` reserves a sequential number and computes the correct
  subtotal/total.
- Concurrent `prepareInvoice` calls for the same org+year never collide on
  the same number.
- `issueInvoice` transitions `PREPARED` -> `ISSUED` and recomputes totals to
  match delivered qty, for both a full-delivery and a partial-delivery case.
- `issueInvoice` throws `INVALID_STATE_TRANSITION` when called twice on the
  same invoice.
