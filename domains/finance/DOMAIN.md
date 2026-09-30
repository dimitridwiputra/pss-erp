# Finance domain

Status: MVP demo implementation in progress. Accounting defaults are **DEMO DEFAULT pending Finance sign-off**. See `docs/decisions/2026-10-01-mvp-demo-accounting-defaults.md` and MVP-OD-1…4.

## Purpose

Finance is the system of record for the general ledger and accounting periods. It turns canonical operational economic events into balanced journals and provides financial reports without reading an operational domain's tables.

## Owns

- Demo chart of accounts and active status.
- Versioned posting rules and journal construction.
- Journal and journal lines, including immutable posted records.
- Accounting periods and close state.
- Finance inbox, posting exceptions, and event-sourced reconciliation totals.
- Buku Besar, Neraca Saldo, Laba Rugi, Neraca, and gross-profit summary queries.

## Does not own

- Inventory cost calculation, stock movements, invoices, payment status, cash custody, or any operational document.
- Approval request storage or identity/permission grants. Finance uses the Platform approval API and Identity public API.
- Tax determination. It posts only the invoice's `taxAmount`.

## Commands

| Command | Status | Notes |
|---|---|---|
| Consume economic event | Implemented | Inbox, posting rule, period check, journal, audit, outbox in one transaction. |
| Retry posting exception | Implemented | Reuses persisted envelope, remains idempotent by source event ID. |
| Create manual journal draft | Implemented | Balanced lines and active account validation; audited and idempotent. |
| Submit, approve, post manual journal | Blocked by MVP-OD-7/8 | Needs confirmed control-account classification and atomic Platform approval handoff. |
| Reverse journal | Blocked by MVP-OD-9 | Reversal date and source type policy need Finance decision. DB supports linked reversal. |
| Soft-close, close period | Implemented | Close checks pending finance exceptions; reason and explicit override required. |
| Reopen period | Blocked by MVP-OD-8 | Must include permission, reason, approval, audit, and re-close. |

## Queries

- Chart of accounts; journals list/detail; per-account Buku Besar with opening balance.
- Neraca Saldo, Laba Rugi, Neraca with current-period profit in equity.
- Finance summary: gross profit today and month to date.
- Posting exceptions and accounting periods.
- Inventory and receivable reconciliation from `finance.subledger_event` versus posted GL, including the expected temporary credit in receivables after an early POS payment.

## Events produced and consumed

Consumed v1: `INVENTORY_RECEIVED`, `INVENTORY_ISSUED`, `INVENTORY_ADJUSTED`, `INVOICE_ISSUED`, `PAYMENT_RECEIVED`, `CASH_CUSTODY_VERIFIED`. `APPROVAL_DECIDED` consumption awaits MVP-OD-8.

Produced v1: `JOURNAL_POSTED`, `ACCOUNTING_PERIOD_CLOSED`. `JOURNAL_REVERSED` awaits MVP-OD-9.

All events use the canonical envelope and versioned strict payloads in `@pss/contracts`. Finance does not edit the event registry.

## Tables

`finance.account`, `finance.accounting_period`, `finance.posting_rule`, `finance.journal`, `finance.journal_line`, `finance.posting_exception`, `finance.event_inbox`, `finance.subledger_event`.

The migration is forward-only: `infrastructure/database/migrations/0001_finance.sql`. No foreign key points into another domain's schema.

## Invariants

- One event ID produces at most one journal (`event_inbox` and `journal.source_event_id` unique).
- Debit equals credit with zero IDR tolerance in the pure rule, before post, and in the database trigger.
- A closed period accepts no journal post. The event becomes a visible posting exception.
- A null inventory cost becomes an exception; zero is not substituted.
- Posted journals and lines cannot be edited or deleted. The only permitted posted-header change is a linked `POSTED → REVERSED` transition.
- Maker and approver IDs differ at the database level. Manual journals never mutate operational state.
- All monetary calculations in TypeScript use `decimal.js`; database money is `numeric(18,2)`.

## Dependencies

- `@pss/contracts` for event and HTTP schemas.
- `@pss/platform` for transactional inbox/outbox, audited idempotent commands, and shared approval workflow.
- `@pss/audit` for event-consumer audit entries.
- Identity public HTTP API for authenticated actor and scoped permission grants. The finance API never reads identity tables.
- `decimal.js` for money arithmetic.

## Open decisions

- MVP-OD-1…4: Finance sign-off on COA, posting rules, PPN, and costing before production use.
- MVP-OD-7: control-account classification for manual journal posting.
- MVP-OD-8: Platform approval type/policy and atomic public request handoff.
- MVP-OD-9: reversal date and system-journal reversal authorization.
- The broader Product PRD specifies production recognition and close controls beyond this MVP. Demo defaults do not settle those policies.

## Acceptance tests

- `domains/finance/tests/posting-rule.test.ts`: all six event rules, gain/loss, tax zero, cash shortage/overage, null cost, balance.
- `domains/finance/tests/finance-ledger.integration.test.ts`: DB balance/immutability/reversal/period lock and receivable/inventory reconciliation.
- `domains/finance/tests/finance-consumer.integration.test.ts`: duplicate delivery, closed-period exception/retry, unvalued cost, replay after interrupted transaction.
- Remaining approval and Playwright maker → checker → trial balance path await MVP-OD-7/8 and the foundation approval handoff.
