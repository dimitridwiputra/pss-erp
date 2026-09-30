# Prompt: Codex (stream B: accounting)

You are stream B of three agents building the PSS MVP demo in parallel (Claude = foundation/POS/sales/cash, OpenCode = back office). Work in a git worktree on branch `mvp/finance`, created from `mvp/integration`.

**Read first, in this order:** `AGENTS.md` (especially §4 Finance Rules and §16 Finance tests), `docs/mvp/MVP_PLAN.md` (your contract with the other agents; §5 event payloads and §8 demo accounting policy are your spec), `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`, `docs/adr/ADR-0013-single-command-pipeline.md`, the finance sections of `docs/PRODUCT_PRD.md`, `domains/finance/DOMAIN.md`, and the existing inbox/outbox code in `domains/platform` and `apps/integration-worker/src/event-pipeline.ts`.

**You own:** `domains/finance`, `apps/finance-api`, the finance consumer registration in `apps/integration-worker`, and the web routes `/keuangan/*`. The `finance` database schema is yours alone (`scripts/check-database.mjs` already maps it). Never read or write another domain's tables. Everything you know about operations arrives as events from plan §5. Do not edit `packages/contracts/src/events/index.ts`; Claude owns it. Build against the plan §5 payloads from Day 1 using local fixtures, and switch to the real schemas once Claude merges them (end of Day 1).

## Day 1
1. Write `docs/decisions/2026-10-01-mvp-demo-accounting-defaults.md`. It records plan §8 (chart of accounts, posting rules v1, periods, costing, PPN, AR timing) as **DEMO DEFAULT pending Finance sign-off**, cross-referencing MVP-OD-1…4.
2. Forward-only migration `domains/finance/infrastructure/database/migrations/0001_finance.sql`:
   - `account` (code, name, type, normal balance, active)
   - `accounting_period` (`YYYY-MM`, status OPEN/SOFT_CLOSED/CLOSED, close/reopen audit fields)
   - `posting_rule` (event type, version, effective dates, line template as JSON validated by Zod)
   - `journal` (number, period, business date, source type, `source_event_id` **unique**, status DRAFT/PENDING_APPROVAL/POSTED/REVERSED, maker, approver, reversal link)
   - `journal_line` (account, debit, credit, `numeric(18,2)`, memo)
   - `posting_exception` (event id, reason, payload reference, status, owner)

   Posted journals and their lines are immutable: add a DB trigger that rejects UPDATE/DELETE after POSTED except the status → REVERSED link. Enforce `SUM(debit) = SUM(credit)` in the domain and verify it again at post time.
3. Seed script for the plan §8 chart of accounts, posting rules v1 and the current period.

## Days 2–4: posting engine and consumers
4. A pure domain rule `buildJournalFromEvent(rule, event)` returns balanced lines or a typed failure. Unit-test every rule in plan §8, including null cost → exception, zero tax → no PPN line, and cash overage vs shortage.
5. Consumers in `apps/integration-worker` using `withInbox`, for `INVENTORY_RECEIVED`, `INVENTORY_ISSUED`, `INVENTORY_ADJUSTED`, `INVOICE_ISSUED`, `PAYMENT_RECEIVED` and `CASH_CUSTODY_VERIFIED`. Each one:
   - dedupes on `eventId` and on `journal.source_event_id`;
   - picks the period from `businessDate`;
   - for a closed period, writes a `posting_exception`; it never posts into a closed period and never drops the event;
   - posts through the ADR-0013 pipeline with audit, and emits `JOURNAL_POSTED` via the outbox.
6. Manual journals: create (maker) → submit → approve (checker ≠ maker, through the existing approval inbox `/persetujuan` and `APPROVAL_DECIDED`) → post. Reversal creates a new reversing journal linked to the original. Manual journals must never change operational state.
7. Periods: soft-close → close (requires no pending exceptions, or an explicit override with a reason), reopen (permission + reason + approval + audit), `ACCOUNTING_PERIOD_CLOSED` event.

## Days 5–6: finance-api and reports
8. `apps/finance-api` REST endpoints with auth (reuse `@pss/auth-client` as `apps/api` does), a permission check per route, Zod validation, idempotency keys on mutations, RFC 9457 problem responses, and pagination:
   - chart of accounts; journals list/detail;
   - Buku Besar per account and date range;
   - Neraca Saldo; Laba Rugi; Neraca (current-period profit shown under equity);
   - posting exceptions list and retry;
   - manual journal commands; period commands.

   Contracts go in `packages/contracts/src/api/finance-*.ts`. Publish a summary query (gross profit today and month to date) for OpenCode's dashboard by Day 5.
9. Reconciliation queries: inventory value per the GL (1-1400) vs the balance reported by inventory, and receivables (1-1300) vs invoices minus payments. Build them from event-sourced subledger totals held in `finance`, never by reading other schemas. Show any difference, including the expected temporary credit balance on receivables described in plan §8.

## Days 6–7: `/keuangan` UI
10. Following `docs/DESIGN_SYSTEM.md`, in Indonesian, with no raw enums: Beranda Keuangan (period status, exceptions count, today's journals), Jurnal (list/detail with a link back to the source document number), Jurnal Manual (form built with React Hook Form + Zod; balance indicator; Submit disabled until balanced), Buku Besar, Neraca Saldo, Laba Rugi, Neraca, Pengecualian Posting, Periode (close/reopen with a reason). Call `/api/bff/finance/*` (Claude's proxy); never call finance-api directly from the browser.

## Days 8–9: freeze
11. AGENTS.md §16 finance tests must be green: journal balance, duplicate posting protection (same event delivered twice → one journal), reversal, period lock, approval separation, subledger ↔ GL reconciliation, replay after the worker is killed mid-batch.
12. Update `domains/finance/DOMAIN.md` with every section AGENTS.md §19 requires, and add a Playwright path: manual journal maker → approver → trial balance shows it.

**Rules:**
- Never invent a business rule. Anything beyond plan §8 goes into plan §10 as an open decision, and you stop there.
- Money is `numeric` in the DB and `decimal.js` in TS, never float.
- Run the full gate list from plan §3 before every merge.
- End each day with a short report: what merged, tests run, what's blocked, and what you need from the other streams.
