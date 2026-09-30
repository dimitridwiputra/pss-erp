# Finance domain

Status: MVP demo implementation in progress. Accounting defaults are **DEMO DEFAULT pending Finance sign-off**. See `docs/decisions/2026-10-01-mvp-demo-accounting-defaults.md` and MVP-OD-1…4.

## Purpose

Finance is the system of record for the general ledger and accounting periods. It turns canonical operational economic events into balanced journals and provides financial reports without reading an operational domain's tables.

## Owns

- Demo chart of accounts, AccountRole metadata and effective AccountRoleMapping (MVP-OD-7).
- Versioned posting rules and journal construction.
- Journal and journal lines, including immutable posted records.
- Accounting periods, approval-correlated close/reopen requests and close state.
- Finance-owned approval effect state, separate from Platform's decision.
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
| Create manual journal draft | Implemented | Balanced lines, active accounts and role-based control-account denial; audited and idempotent. |
| Submit, approve, post manual journal | Implemented | Finance stages pending subject, version and request outbox atomically; Platform decides; Finance applies through its inbox. |
| Request journal reversal | Implemented | Only MANUAL/ADJUSTMENT/eligible OPENING; reason, maker-checker approval, linked opposite lines, late date policy. Human SYSTEM reversal is forbidden. |
| Consume SYSTEM compensation | Implemented for `PAYMENT_REVERSED` | Requires registered active compensation rule, original event/posting, source reference and idempotency. Payments producer is an integration dependency. |
| Soft-close, request close period | Implemented | Close request checks pending exceptions and requires Platform approval; direct API close no longer executes the effect. |
| Request period reopen | Implemented | Reason, permission, CFO approval, audit, SOFT_CLOSED reopen state and outbox event. |

## Queries

- Chart of accounts; journals list/detail; per-account Buku Besar with opening balance.
- Neraca Saldo, Laba Rugi, Neraca with current-period profit in equity.
- Finance summary: gross profit today and month to date; scoped Control Station summary with Net Sales, COGS, Gross Profit, Gross Margin %, and previous comparable periods from posted Finance lines.
- Posting exceptions and accounting periods.
- Inventory and receivable reconciliation from `finance.subledger_event` versus posted GL, including the expected temporary credit in receivables after an early POS payment.

## Events produced and consumed

Consumed: `INVENTORY_RECEIVED`, `INVENTORY_ISSUED`, `INVENTORY_ADJUSTED`, `INVOICE_ISSUED`, `PAYMENT_RECEIVED`, `PAYMENT_REVERSED`, `CASH_CUSTODY_VERIFIED` v1, and `APPROVAL_DECIDED` v2. A v1 decision has no subject version and cannot apply a Finance effect.

Produced v1: `FINANCE_APPROVAL_SUBMITTED`, `JOURNAL_POSTED`, `JOURNAL_REVERSED`, `ACCOUNTING_PERIOD_CLOSED`, `ACCOUNTING_PERIOD_REOPENED`.

All events use the canonical envelope and versioned strict payloads in `@pss/contracts`. Approval type codes are in the generated PRD registry, not local Finance constants.

## Tables

`finance.account`, `finance.account_role`, `finance.account_role_mapping`, `finance.accounting_period`, `finance.period_close_request`, `finance.period_reopen_request`, `finance.approval_effect`, `finance.posting_rule`, `finance.journal`, `finance.journal_line`, `finance.posting_exception`, `finance.event_inbox`, `finance.subledger_event`.

Forward-only migrations: `0001_finance.sql` through `0005_rejected_reversal.sql`. No foreign key points into another domain's schema.

## Invariants

- One event ID produces at most one journal (`event_inbox` and `journal.source_event_id` unique).
- Debit equals credit with zero IDR tolerance in the pure rule, before post, and in the database trigger.
- A closed period accepts no journal post. The event becomes a visible posting exception.
- A null inventory cost becomes an exception; zero is not substituted.
- Posted journals and lines cannot be edited or deleted. The only permitted posted-header change is a linked `POSTED → REVERSED` transition.
- Rejected reversal requests remain `REJECTED` for audit and do not prevent a later corrected request.
- Maker and approver IDs differ at the database level. Manual journals never mutate operational state.
- Control status comes only from AccountRoleMapping and role metadata, never a code/name prefix. Manual and adjustment lines with `DENY` are blocked on creation, submit and post.
- A Platform decision does not imply the Finance effect succeeded: `approval_effect` records `PENDING`, `APPLIED`, `STALE` or `FAILED` and deduplicates by request ID.
- A Branch Manager's gross-profit aggregate is filtered in Finance SQL by authorized branch. If posted revenue/COGS lines lack branch attribution, the branch query refuses to present a partial result.
- All monetary calculations in TypeScript use `decimal.js`; database money is `numeric(18,2)`.

## Dependencies

- `@pss/contracts` for event and HTTP schemas.
- `@pss/platform` for transactional inbox/outbox, audited idempotent commands, and shared approval workflow.
- `@pss/audit` for event-consumer audit entries.
- Identity public HTTP API for authenticated actor and scoped permission grants. The finance API never reads identity tables.
- `decimal.js` for money arithmetic.

## Open decisions

- MVP-OD-1…4: Finance sign-off on COA, posting rules, PPN, and costing before production use.
- MVP-OD-7…10 are DECIDED in ADR-0015 and `docs/mvp/MVP_PLAN.md` §10.
- Source producers must attach authoritative branch attribution to revenue and COGS events before the Branch Manager card can be complete. The current inventory issue v1 envelope permits an absent branch; Finance fails the branch query closed in that case.
- The Payments owner has not yet implemented emission of `PAYMENT_REVERSED`; the Finance consumer and contract are ready.
- The local Playwright maker → approver → Neraca Saldo path requires two Finance test identities and a recent approver OTP; the self-contained CI browser gate does not provision those identities.
- The broader Product PRD specifies production recognition and close controls beyond this MVP. Demo defaults do not settle those policies.

## Acceptance tests

- `domains/finance/tests/posting-rule.test.ts`: all six event rules, gain/loss, tax zero, cash shortage/overage, null cost, balance.
- `domains/finance/tests/finance-ledger.integration.test.ts`: DB balance/immutability/reversal/period lock and receivable/inventory reconciliation.
- `domains/finance/tests/finance-consumer.integration.test.ts`: duplicate delivery, closed-period exception/retry, unvalued cost, replay after interrupted transaction.
- `domains/finance/tests/finance-approval.integration.test.ts`: control-account rejection, atomic approval request/outbox rollback, duplicate/stale decision, manual reversal dates, SYSTEM reversal denial, close/reopen approval.
- `domains/finance/tests/gross-profit-summary.integration.test.ts` and `apps/finance-api/tests/gross-profit-scope.test.ts`: posted branch aggregation and scope denial.
- `apps/web/tests/e2e/finance-manual-journal.spec.ts`: maker → checker → Neraca Saldo using two local Finance accounts. Run from the repository root with `PSS_FINANCE_E2E_MAKER_USER`, `PSS_FINANCE_E2E_MAKER_PASSWORD`, `PSS_FINANCE_E2E_APPROVER_USER`, `PSS_FINANCE_E2E_APPROVER_PASSWORD`, and a fresh `PSS_FINANCE_E2E_APPROVER_OTP`: `pnpm --filter @pss/web exec playwright test -c playwright.e2e.config.ts tests/e2e/finance-manual-journal.spec.ts`. It skips without those credentials.
