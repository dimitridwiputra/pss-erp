# Platform domain

Status: PLT-004 outbox, PLT-005 inbox/retry/DLQ/replay, PLT-006 command idempotency, and the DQ-001 exception queue foundation are implemented. Their worker scheduling, alerting, and the DQ-001 unified screen remain open.

## Purpose

Provide shared persistence and delivery infrastructure for canonical domain events, plus the single exception queue every bounded domain opens work into. A domain keeps authority over the business fact, its event content, and its subject; Platform owns transport state, delivery bookkeeping, and queue lifecycle.

## Owns

`platform.outbox_event`, `platform.event_dead_letter`, `platform.idempotency_key`, `platform.queue_definition`, `platform.exception_item`, `platform.business_calendar_day`, dispatch mechanics, dead-letter replay, command replay, and exception queue lifecycle. Platform provides a reusable `withInbox` transaction boundary, but each consumer owns its inbox table and business effect. This module does not define domain event payloads; `@pss/contracts` validates those before an insert or send.

## Does not own

Business aggregates, audit entries, consumer inbox tables, event consumers, operational read models, or any subject row an exception item points at. `ExceptionItem.subject` is a `(domain, type, id)` reference only; Platform never reads or writes the subject's table (DQ-001.NC02).

## Commands

### Delivery

- `appendOutboxEvent(client, event)` validates the event type, version, producer, aggregate, and implemented payload schema, then inserts into the caller's active transaction. Call with the same client as the domain mutation and audit entry.
- `dispatchPendingEvents(pool, transport, options)` selects events that are unpublished, not dead-lettered, and past `next_attempt_at`, honouring per-aggregate order with `FOR UPDATE SKIP LOCKED`. `options` is `{ limit, retryBackoffMs, onFailure }` and also accepts a bare limit for existing callers. It returns `{ published, oldestPendingCreatedAt, attempts }`. A failed send no longer throws: it records the attempt, schedules the next try from the backoff table, and moves on, so one broken aggregate cannot stall the dispatcher (PLT-004.E1).
- `deleteDispatchedOutboxEvents(pool, retentionDays = 400)` and `deleteClosedDeadLetters(pool, retentionDays = 400)` are retention jobs. They only touch finished rows; nothing pending or open is removed by a clock.
- `withInbox(pool, inbox, event, handler, options)` validates a registered event and opens one transaction. The consumer-owned `inbox.reserve` callback inserts its `(consumer_name, event_id)` receipt using the supplied client; the handler receives that same client for its effect. Duplicate delivery skips the handler; a handler or commit failure rolls back both receipt and effect. With `options.ordering`, the consumer declares how it reads its own applied aggregate version: an event beyond `applied + 1` returns `DEFERRED` and writes nothing, so a version gap cannot corrupt a read model (PLT-005.A1).
- `recordConsumerDeadLetter(pool, { consumerName, event, attemptCount, cause, expectedVersion?, error? })` is the terminal step once a transport has spent its own attempt budget. It upserts one row per `(event, consumer)` with the failure code, class, attempt count, and both timestamps. `cause` is `HANDLER_FAILED` (classified from the error) or `OUT_OF_ORDER`.
- `replayDeadLetter` and `discardDeadLetter` run through `withAuditedTransaction`, so the OPEN -> REPLAYED / DISCARDED transition and its audit entry commit together or not at all (AGENTS.md 14, PLT-005.R03). Replay also clears the dead-letter flag on the outbox row so the dispatcher retries the event.

### Exception queue (DQ-001)

- `openException(pool, input)` opens an item in its own audited transaction. `openExceptionInTransaction(transaction, input)` does the same inside the calling domain's transaction, so the item, the domain mutation, and the domain's outbox event share one commit (AGENTS.md 3.5). Both are keyed on `(queue_code, dedupe_key)`: a re-fire updates the active item and increments `occurrence_count` rather than creating a second one, and a partial unique index makes that safe under concurrency (DQ-001.AC01, TS01).
- `updateException(pool, input)` merges context. It cannot change the queue or the subject.
- `claimExceptionItem` / `releaseExceptionItem` move OPEN <-> IN_PROGRESS under a row lock and an injected `AuthorizeException` decision. Release is the assignee's only.
- `resolveException(pool, input)` is callable only by the domain recorded in `owner_domain`, and only with the command that actually succeeded (DQ-001.BR01, NC01).
- `recordExceptionCommandFailure` leaves the item where it is and stores the domain's error message, which is DQ-001.AC04.
- `dismissException` requires a registry queue with `dismissible = true`. No Appendix P queue is marked dismissible, so the call is refused with `INVALID_STATE_TRANSITION` (DQ-001.BR04, AC06).
- `escalateOverdueExceptions` marks past-SLA items overdue and appends the registry escalation roles to the item's visible roles, in one audited transaction, and is safe to re-run.
- `registerBusinessCalendarDay` records a non-working date for a branch or the organization. The empty calendar is the registered default: Monday to Friday, no holidays (Appendix N section 68).

## Queries

- `listOpenDeadLetters` and `summariseDeadLetters(pool)` give PLT-005.R02 its depth and age per consumer; `outboxDeliveryStats(pool)` gives PLT-004.R05 its pending count, oldest pending event, and dead-letter count.
- `listQueueDefinitions(pool)` is the registry the queue screen and role routing read.
- `listExceptionItems(pool, filter, authorize)` filters by organization, status, queue, branch, overdue, and owner/escalation role **in SQL**, then delegates finer scope (territory, warehouse, own-only) to `authorize` per row. Keyset pagination on `(sla_due_at, id)`.
- `exceptionQueueMetrics(pool)` reports open, overdue, resolved, and resolution-time p50/p95 per queue (DQ-001.R04).

## Events produced and consumed

The outbox transports validated events from the canonical catalog. It is neither the producer of business facts nor an event consumer.

## Tables

`platform.outbox_event` (0001, extended by 0005) stores the validated envelope, event ID, type, aggregate key/version, creation time, publish time, attempt count, next attempt time, last failure code, and the dead-letter pointer. `platform.idempotency_key` (0002) stores scope, request hash, status, compact response, creation time, and expiry; the database enforces at least seven days of retention.

`platform.event_dead_letter` (0005) is the durable dead-letter queue for both stages: `OUTBOX` (the broker would not accept it) and `CONSUMER` (the handler kept failing, or a version gap outlasted its deferrals). It stores the full envelope, failure code and class, attempt count, first/last failure times, the OPEN/REPLAYED/DISCARDED state, and the replay count. PostgreSQL is the home on purpose: a BullMQ failed set is lost whenever Redis is wiped, and PLT-005.BR03 forbids discarding a dead letter automatically. An open dead letter is never deleted by retention.

`platform.queue_definition` (0006) holds the Appendix P registry: code, label, owner roles, escalation roles, SLA unit and default, an optional config-key SLA, permitted action labels, an optional reason-code allow-list, and `dismissible`. `platform.business_calendar_day` (0006) holds the non-working dates, national first then branch-scoped. `platform.exception_item` (0006) is the queue item: organization/branch, queue code, subject reference, owning domain, owner roles as captured at open, escalation roles once overdue, reason code, minimal context, dedupe key, status, assignee, SLA due time, overdue/escalated times, last command error, resolution, dismissal, occurrence count, and version. Migration 0007 seeds the registry from Appendix P verbatim.

`ExceptionTransition` is represented by the append-only `audit.audit_entry` trail, not a second table: a duplicate transition log would be a second source of truth for the same fact (AGENTS.md 18).

Each consuming domain must create its own `<schema>.inbox_event(consumer_name text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer_name, event_id))` in that domain's migration. Platform has no cross-domain inbox table.

## Invariants

- A rolled-back domain transaction leaves no outbox event.
- The dispatcher does not bypass an older pending event for the same aggregate, and an older **dead-lettered** event stops blocking its aggregate, so a permanently stuck version cannot freeze every later one.
- A failed transport call leaves the event pending for retry; delivery is at least once; consumers must deduplicate by `eventId`.
- A failed handler leaves the event pending; the dead letter is only written after the attempt budget is spent.
- A dead letter exists at most once per `(event, consumer)` while open; a repeat failure raises its attempt count and version.
- Replay and discard always write an audit entry, and a second replay of a closed dead letter is rejected.
- Concurrent retries with one scoped idempotency key execute once. Replay returns the stored status and body. A changed hash is rejected.
- The application must supply an audit-enforcing runner before using a command wrapper for a mutation. Audit, outbox, idempotency response, and the owning mutation can share its one `pg` client.
- A consumer handler must write all of its effects with the supplied `PoolClient`. The inbox receipt and effect commit together. The queue ack follows a successful return, never precedes it.
- An exception item has one active row per `(queue, dedupe_key)`. Its owner roles are frozen at open, so a later registry change cannot silently hand an open item to a different role.
- An escalation role can only see an item after it is actually overdue.
- Platform computes an SLA but never invents one: a queue whose Appendix P entry is not a duration (Appendix P writes "per tipe" for `Q-APPROVAL_PENDING` and "sebelum close" for `Q-GL_SUBLEDGER_VARIANCE`, and five P.2 queues name only a KOSONG config key) refuses to open until its owner registers a value.

## Dependencies

PostgreSQL `pg`, `@pss/contracts` event and error-code validation, `@pss/audit` for the audit-enforcing transaction, and Zod input validation. The application layer composes Platform with Audit through their public interfaces. `EventTransport` is an adapter interface; the BullMQ implementation lives in `apps/integration-worker`.

## Open decisions and limits

**DQ-001 (open).** These are blockers for DQ-001 completeness, not code gaps:

- `Q-APPROVAL_PENDING` SLA is "per tipe" and `Q-GL_SUBLEDGER_VARIANCE` SLA is "sebelum close" in Appendix P. Neither is a duration, so both queues are registered but refuse to open. Finance must register the real values (or confirm these two queues are served by another engine).
- `tax.invoice_deadline_days`, `pos.pickup.sla_minutes`, `pos.shift.max_hours`, `pos.transfer.max_wait_hours`, and `pos.qris.settlement_days` are KOSONG in Appendix N, so the five P.2 queues that name them also refuse to open until the key has a value.
- `dismissible` is false for every seeded queue because Appendix P does not state it. Owners must confirm which queues permit dismissal, and with which registered reason codes.
- `reason_codes` is empty for every seeded queue. Appendix P states a trigger *condition* (a fingerprint match, "CUS-003", "FR short"), not a code set, and the Appendix F reason-code registry has no entries for the DQ area. Enumeration is a per-queue decision for the queue owners; the column is enforced as soon as it is filled.
- `escalation_roles` is empty where Appendix P writes "—" (`Q-POSSIBLE_DUPLICATE_CUSTOMER`, `Q-STREAM_UNASSIGNED`, `Q-OUTLET_UNMAPPED_LOCATION`, `Q-AP_LEDGER_REJECTED`, `Q-LOCATION_REVIEW`, `Q-POS_TRANSFER_PENDING`, `Q-POS_QRIS_UNSETTLED`) or a level rather than a role (`Q-APPROVAL_PENDING` -> "Level berikutnya").
- `platform.business_calendar` is KOSONG in Appendix N (gate F3). The implemented default is the registered one, Monday to Friday with no holidays, and the table and loader exist so a branch calendar needs no code change.
- `EXCEPTION_OPENED` and `EXCEPTION_RESOLVED` are already in the event catalog (Appendix C.7, producer `platform`, aggregate `ExceptionItem`, payload keys `itemId, queueCode, subjectRef`), but `@pss/contracts` has no registered payload schema for either, so `appendOutboxEvent` would reject them. The transitions and their audit entries are complete; publishing the two events, plus `EXCEPTION_ESCALATED` (C.8), needs schema registration in `packages/contracts` by its owner.
- AC05 notification is deferred to NTF-001 (Sprint 5). `escalateOverdueExceptions` marks the item and widens visibility; it sends nothing and marks nothing notified.
- DQ-001.AC03's `EXCEPTION_RESOLVED` publication and DQ-002's unified per-role screen are not implemented.

**PLT-004 (partial).** A DB transaction is still held during the transport call. The dispatcher must move to a bounded lease/ack pattern before PLT-004.R02 throughput is claimed. There is no consumer fan-out registry, no per-partition queue, no lag alert, and no throughput test.

**PLT-005 (partial).** `withInbox` proves exactly-once for handlers that use the supplied client; it does not cover a handler that uses a different connection or calls an external system. There is no fitness check enforcing inbox usage in CI (PLT-005.NC01), no DLQ dashboard (OBS-002), and no `events.dlq_alert_minutes` alert. Retention helpers exist but nothing schedules them.

**PLT-006 (partial).** The NestJS interceptor, generated required-key endpoint list, request hash canonicalization at the API boundary, privacy review of stored response bodies, daily cleanup scheduling, and hit/conflict metrics are pending.

## Acceptance tests

`domains/platform/tests/outbox.integration.test.ts` verifies rollback, event validation, per-aggregate order, and at-least-once duplicate behaviour after a send succeeds but acknowledgement fails.

`domains/platform/tests/event-delivery-reliability.integration.test.ts` covers the registered backoff table, delayed retry, exhaustion into a dead letter that frees the aggregate, failure classification, duplicate suppression, a version gap that defers and then applies once the gap closes, out-of-order exhaustion into one visible dead letter, a handler failure's code/attempts/timestamps, audited replay, replay releasing a dead-lettered outbox row, audited discard with a mandatory reason, DLQ depth/age summary, and both retention helpers.

`tests/integration/event-pipeline.integration.test.ts` runs the real PostgreSQL + BullMQ path: an audited delivery projected once and tolerant of replay, a worker that dies mid-batch and is replaced without loss or duplication, and a permanently failing consumer that ends in a dead letter, is audited on replay, and then projects exactly once.

`domains/platform/tests/exception-queue.integration.test.ts` covers the Appendix P seed, `QUEUE_UNKNOWN`, the working-day SLA including a branch holiday and a config override, the fail-closed queues, dedupe under concurrency, reopen after resolution, claim/fail/release/resolve, the owning-domain rule, the audit trail per transition, refusal to dismiss, role and branch scope filtering, escalation and re-run safety, per-queue metrics, and the 100k active-item query.

`domains/platform/tests/inbox.integration.test.ts` and `domains/platform/tests/approval.integration.test.ts` cover duplicate delivery, rollback, and approval idempotency.
