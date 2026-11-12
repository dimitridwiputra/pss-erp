# tax domain

Status: TAX-001 (TaxCode + effective-dated TaxRate + approval-gated activation) and the TAX-002
sales-tax resolver are implemented. TAX-003 (input VAT on supplier invoices), TAX-004 (faktur pajak
numbering/export) and TAX-005 (DJP integration) are not — see "Open decisions".

## Purpose

Own the tax vocabulary and the rates a company transacts under, and compute the tax on a sales
document. A rate is regulatory data with an effective date and an approval, never a constant in code,
so a regulatory change is a data change and every document records the tax configuration it was
priced under.

## Owns

- `core.tax_code` — the statutory vocabulary (VAT_OUTPUT, VAT_INPUT, EXEMPT, NON_VAT) and whether a
  code carries a rate at all (`zero_rated`). Global, not per organization.
- `core.tax_rate` — an organization's rate per code, effective-dated and approval-gated. `rate` is
  percentage points (`11.000000` = 11%), never a fraction and never a float.
- `core.tax_inbox_event` — this domain's receipt table for the `APPROVAL_DECIDED` consumer.
- The TAX-002 sales-tax computation: applied code, rate, tax base, amount, and the rounding rule
  used. TAX-002's OWNED ENTITIES is "none" — the result is stored on the caller's document, not here.

## Does not own

- Tax-to-account mapping. That is Finance's `AccountRoleMapping` via the `VAT_OUTPUT` / `VAT_INPUT`
  account roles (PRD §28, TAX-001 DOMAIN OWNER). Not modelled here.
- The customer or product record. `@pss/master-data` owns `core.customer.tax_treatment` and
  `core.product.tax_code`; this domain reads them through master-data's public functions and never
  from `core.*` directly (AGENTS.md §3.1).
- The invoice. `@pss/invoicing` owns `sales.invoice` / `sales.invoice_line` and writes what this
  domain returns onto them.
- Input VAT on a supplier invoice (TAX-003) and the tax-invoice number (TAX-004).

## Commands

- `scheduleTaxRate(pool, client, input)` — writes a rate row as `SCHEDULED` with the approval it
  waits on, and closes its predecessor's open range at the new rate's `valid_from`. Audited as
  `TAX_RATE_SCHEDULED`. There is deliberately **no path from this command to `ACTIVE`**: activation is
  `applyApprovalDecision`'s job, which is what makes TAX-001.NC02 structural rather than a
  convention. A zero-rated code is refused. Overlapping ranges are refused by
  `tax_rate_effective_range_excl`, not by a pre-check, because a pre-check still races two
  concurrent schedulers.
- `applyApprovalDecision(pool, event)` — the `APPROVAL_DECIDED` consumer (DEC-109). Moves a rate to
  `ACTIVE` when the decision approves it, audits it as `TAX_RATE_ACTIVATED`, and does nothing for a
  rejection, an expiry, another approval type, another owner domain, or another organization.
  Exactly-once via `core.tax_inbox_event`. Declined `TAX_RATE_ACTIVATED` publication — see below.

## Queries

- `loadApplicableTaxRates(client, organizationId, businessDate)` — the `ACTIVE` rows covering a
  business date. Only ACTIVE, so a rate awaiting approval cannot be applied.
- `loadTaxCodes(client)` — the whole vocabulary, including `zero_rated` for codes that have no rate
  row and so never appear in the query above.
- `loadConfigValueInForce(pool, key, { organizationId, branchId, businessDate })` /
  `loadRoundingRule(...)` — one registered configuration value in force, resolved by
  `@pss/configuration`'s `getConfig` over rows read by `@pss/platform`'s `loadConfigRows`. Neither
  problem is re-implemented here.
- `calculateSalesTax(pool, client, input)` — the TAX-002 entry point a caller uses: a document's
  lines in, each line's code/rate/base/amount plus the document total out.

## Domain rules (pure functions)

- `resolveSalesTax({ taxBase, customerTaxTreatment, productTaxCode, businessDate, taxRates,
  taxCodes, roundingRule })` → `{ taxCode, rate, taxBase, taxAmount, rateId, roundingRule }`, or a
  `TAX_RATE_NOT_CONFIGURED` / `TAX_CODE_MISSING` rejection. No database access and no configuration
  read, so it is a pure function of its inputs (TAX-002.R02) and re-runnable by hand.
- `resolveSalesTaxOnSnapshot({ taxBase, snapshot })` — recomputes an amount from the snapshot a
  document line already carries. This is what keeps an issued invoice's tax fixed (TAX-002.BR03/NC01)
  while still following a change in quantity.
- `parseRoundingRule(rawValue, { configKey })` and `taxAmount({ taxBase, rate, roundingRule })` — the
  rounding contract. `taxAmount` is `Decimal` (decimal.js) end to end; no rate or amount ever passes
  through a JavaScript float (TAX-002.R01/NC02, DB.R04, AGENTS.md §6).

## Events produced and consumed

- Consumed: `APPROVAL_DECIDED` (payload schema registered in `packages/contracts`), by
  `applyApprovalDecision`.
- **Not produced: `TAX_RATE_ACTIVATED`.** `TAX-001 EVENTS EMITTED` names it and Appendix C.1
  registers `producer: tax` / `aggregate: TaxRate` / `payloadKeys: taxCode, rate, validFrom` in the
  catalog — but `packages/contracts/src/events/index.ts`'s `eventSchemaRegistry` has no payload schema
  for it, and `appendOutboxEvent` refuses any event that has none. Registering that schema is a
  `packages/contracts` change this domain does not own. The activation is instead observable through
  the `TAX_RATE_ACTIVATED` audit entry, which is written in the same transaction as the status
  change. Recorded as an open decision.

## Tables

Both in schema `core` — PRD §18.2 puts "kode & tarif pajak" in `core`, owned by the tax module, and
`scripts/check-database.mjs`'s `schemaOwners` agrees (`core`'s owners include `tax`).

- `core.tax_code` — `UNIQUE (code)`; `zero_rated` marks EXEMPT and NON_VAT as carrying no rate.
- `core.tax_rate` — `organization_id` NOT NULL; `EXCLUDE USING gist (organization_id, tax_code_id,
  daterange(valid_from, COALESCE(valid_to, 'infinity'), '[)'))` is DB.R06's no-overlap rule; triggers
  reject rewriting `rate` / `tax_code_id` / `valid_from` / `organization_id` / `approval_id` and reject
  DELETE, which is TAX-001.BR02 enforced by the database. `approval_id` is a bare uuid, not a
  foreign key: it references `platform.approval_request` and DB.R02 forbids cross-schema FKs.
- `core.tax_inbox_event` — `(consumer_name, event_id)` primary key.

Migrations: `0001_tax_code_and_rate.sql` (creates `core` and `btree_gist`), `0002_tax_inbox_event.sql`,
`0003_tax_code_reference.sql` (the four statutory codes as reference rows, so no environment has to
insert them by hand before a zero-tax sale can resolve; no rate, no organization).

## Invariants

- **No rate literal anywhere in the domain (TAX-001.R01).** `taxAmount` divides by a named
  `PERCENT_SCALE` constant — a unit conversion, not a rate. Every rate arrives as data from
  `core.tax_rate` or from an invoice's own snapshot. `domains/tax/tests/tax-resolver.test.ts` asserts
  the amount scales linearly with the rate it is handed, which a literal could not do.
- **No default rate (TAX-001.NC01).** A taxable code with no applicable rate on the business date
  raises `TAX_RATE_NOT_CONFIGURED`; nothing computes at zero.
- **No rate becomes ACTIVE without an approval (TAX-001.NC02).** `scheduleTaxRate` has no ACTIVE path,
  `loadApplicableTaxRates` returns only ACTIVE rows, and the DB rejects rewrites.
- **A zero-rated code is never blocked on configuration it does not use.** EXEMPT and NON_VAT resolve
  to rate 0 without consulting a rate row, `tax.vat_output_rate`, or `tax.rounding_rule`.
- **An unset or unrecognised `tax.rounding_rule` is blocking (TAX-000.R03).** It is rejected for a
  taxable line, never defaulted. `taxAmount` additionally refuses an empty mode rather than letting
  `Decimal`'s default rounding apply.
- **Money and rates are decimal strings end to end.** The `taxBase` is computed by PostgreSQL from
  `qty * unit_price` and read back as `numeric::text`; the rate and amount never see a JS float.
- **Business dates are Asia/Jakarta `date` values**, and `valid_from` / `valid_to` are cast to text
  in SQL because node-postgres would otherwise materialise them at local midnight and shift them by
  the server's UTC offset.
- **Every mutation goes through `withConnection` / `withAuditedWork`** (ADR-0013) and writes its audit
  entry in the same transaction (DB.R09).

## How output VAT and input VAT are kept separate

Two registered configuration keys and two separate code paths, deliberately not merged:

- **Output VAT** — key `tax.vat_output_rate`. `calculateSalesTax` reads it only to establish that the
  organization is registered to charge output VAT; **its value is never used as the rate.** The rate
  comes from the effective-dated `core.tax_rate` row for `VAT_OUTPUT`, which is what carries the
  approval reference and the effective dating. A document with no `VAT_OUTPUT` line, or one whose
  customer treatment is EXEMPT/NON_VAT, is not gated on the key at all — a legitimate zero-tax
  invoice must not be blocked by configuration it does not use.
- **Input VAT** — key `tax.vat_input_rate`, code `VAT_INPUT`, the supplier purchase flow (TAX-003).
  Nothing in this domain's sales path reads it, and no command in this domain consumes it yet,
  because `procurement` does not exist in this build. `core.tax_rate` stores a `VAT_INPUT` rate the
  same way, so the eventual `CalculatePurchaseTax` reads its rate from its own row and its gate from
  its own key.

So the two are separated by code (`VAT_OUTPUT` vs `VAT_INPUT`), by key, and by the fact that only the
sales resolver runs in this slice.

## Dependencies

- `@pss/contracts` — `DomainError`, `DecimalStringSchema`, `BusinessDateSchema`, `newEventId`,
  `ApprovalDecidedV1Schema`, the error-code registry.
- `@pss/platform` — `withConnection` (the one audited-transaction primitive, ADR-0013), `withInbox`,
  `loadConfigRows` (PLT-009's audited read path).
- `@pss/configuration` — `getConfig`, which owns configuration effective-dating and scope ranking.
- `@pss/audit` — `runAuditedWork` for the inbox-driven activation.
- `decimal.js` — exact decimal arithmetic (TAX-002.R01). Already in the workspace via `apps/web`.
- No dependency on another business domain.

## Open decisions

- **`TAX_RATE_ACTIVATED` is not published.** The event is in Appendix C.1's catalog but has no payload
  schema in `packages/contracts`'s `eventSchemaRegistry`, so `appendOutboxEvent` refuses it. Needs a
  `TaxRateActivatedV1Schema` registered with `payload: { taxCode, rate, validFrom }` by whoever owns
  `packages/contracts`. Until then the activation is visible only through the audit trail.
- **`tax.rounding_rule`'s scope is not encoded in its value.** TAX-002.BR02 says Finance/Tax decide
  "per line or per document", and TAX-002.AC01's worked example rounds a single line
  (`pembulatan(10.000.000 × r)`). This slice implements per-line rounding and the value is a bare mode
  from `{HALF_UP, HALF_EVEN, HALF_DOWN, UP, DOWN}`; a value naming a scope, such as
  `PER_LINE:HALF_UP`, is rejected rather than guessed at. Finance/Tax must confirm the vocabulary and,
  if document-level rounding is wanted, say how a rounded document total is allocated back to lines.
- **`tax.rounding_rule`'s value is not schema-validated.** PLT-009 stores configuration values as
  untyped JSON, so the accepted vocabulary lives only here. A configuration-level enum for the key
  would be the better home; until then an unrecognised value blocks with a message naming the key.
- **The product's default tax code is `core.product.tax_code`, which nothing writes yet.** Migration
  `domains/master-data/.../0002_customer_tax_treatment.sql` adds the column, and
  `createCustomer` accepts a customer treatment, but `master-data` still has no product write path at
  all — so every product row has `tax_code IS NULL` and every taxable invoice is refused with
  `TAX_CODE_MISSING`. That is the PRD's intended fail-closed behaviour (TAX-002.E1), but it means the
  tax path cannot be exercised in production until master data ingestion exists or a setter is added.
- **A customer created without a treatment blocks its own first invoice.** `createCustomer` and
  `getOrCreateWalkInCustomer` accept no default treatment, deliberately: defaulting to VAT_OUTPUT
  would be a tax decision made by whoever omitted the field, and defaulting to NON_VAT would waive tax
  the same way. A POS walk-in customer therefore needs its treatment set before POS checkout succeeds.
  Whether a walk-in counter sale should be treated as VAT-taxable by default is a **product decision,
  not an engineering one**, and is not made here.
- **`core.tax_code` is global while `core.tax_rate` is per organization.** The vocabulary's meaning
  does not change between tenants (the same reasoning `platform.config_key` records); the rates a
  company transacts under are its own (DB.R11). If multi-tenant PKP status ever diverges at the
  vocabulary level, the code table needs an organization scope.
- **`createTaxCode` is not implemented.** `scheduleTaxRate` requires the code row to exist and the
  vocabulary rows are seeded per environment. TAX-001 main flow step 1 ("Finance membuat kode pajak")
  has no command; the four statutory codes are the ones PRD §28 lists, so a command would create only
  names for an existing code.
- **Tax-to-account mapping (VAT_OUTPUT / VAT_INPUT account roles) is not modelled.** Finance owns it
  (PRD §28) and `finance` does not exist in this build.
- **`tax.rate.manage` has no enforcement point yet.** TAX-001 requires that permission; this domain has
  no `interfaces/http`, so authorization would live at the route. `scheduleTaxRate` records the actor
  in its audit entry, which is the trace but not the control.
- **The TAX-001.R01 fitness function is domain-local.** `scripts/check-architecture.mjs` is the natural
  home for a workspace-wide "no rate literal" rule, and this change does not own that file.
  `domains/tax/tests/tax-resolver.test.ts` therefore carries a scan of this domain's own `src/` that
  fails on a bare rate literal outside a comment — enforcement now, with the workspace rule still to be
  written. The scan is deliberately narrow (it can be fooled by a rate in a string built at run time)
  and should be replaced rather than kept as the long-term gate.
- **TAX-003, TAX-004 and TAX-005 are not implemented.** No `procurement` domain exists; no faktur
  pajak numbering table; no DJP export format is specified (TAX-000.R02 / OD-112).

## Acceptance tests

- `domains/tax/tests/tax-resolver.test.ts` (unit, no database) — the pure resolver, the rounding
  contract, the snapshot recomputation, and every fail-closed path: no rate, KOSONG rounding rule,
  unrecognised rounding value, no product code, no customer treatment, a date no rate covers, a gap in
  the rate history, a negative base. Also the determinism and no-float properties.
- `domains/tax/tests/tax-domain.integration.test.ts` (PostgreSQL) — `scheduleTaxRate` writes a new row
  and closes its predecessor; the audit entry names the rate and the approval; the exclusion
  constraint refuses an out-of-order rate; a rewrite or a delete is rejected by the trigger; a rate is
  not applicable while SCHEDULED; `APPROVAL_DECIDED` activates it and audits; a rejection does not; a
  redelivery activates once; an approval for another organization, owner domain or type is ignored.
- `domains/invoicing/tests/invoicing-tax.integration.test.ts` — the end-to-end decision IDs, see
  `domains/invoicing/DOMAIN.md`.