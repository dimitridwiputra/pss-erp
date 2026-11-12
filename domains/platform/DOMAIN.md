# Platform domain

Status: PLT-004 outbox, PLT-005 inbox/retry/DLQ/replay, PLT-006 command idempotency, the DQ-001 exception queue foundation, the PLT-009 configuration registry, the PLT-010 feature flag registry, and the DOC-001 document numbering mechanism are implemented. Their worker scheduling, alerting, the DQ-001 unified screen, and the registration of the two new admin controllers in `apps/api` remain open.

## Purpose

Provide shared persistence and delivery infrastructure for canonical domain events, plus the single exception queue every bounded domain opens work into. A domain keeps authority over the business fact, its event content, and its subject; Platform owns transport state, delivery bookkeeping, and queue lifecycle.

`platform.approval` is the one shared approval mechanism (MVP-OD-8; ADR-0015). It owns ApprovalType, ApprovalRequest, ApprovalStep, routing, thresholds, expiry, delegation, SoD, concurrent decision protection and decision audit. It never reads or mutates another domain's subject table. `FINANCE_APPROVAL_SUBMITTED` is consumed through `platform.approval_inbox`; request creation, step, audit and Platform outbox are one transaction. A final decision, audit and `APPROVAL_DECIDED` v2 outbox are one transaction. The owner domain applies and tracks the business effect independently.

`finance.branch_pnl_visible` remains the separate CFO-owned sensitive configuration for detailed branch P&L. Migration `0012_branch_pnl_config_owner.sql` corrects its owner role; it does not grant gross-profit-summary access or alter that permission.

## Owns

`platform.outbox_event`, `platform.event_dead_letter`, `platform.idempotency_key`, `platform.queue_definition`, `platform.exception_item`, `platform.business_calendar_day`, `platform.config_value`, `platform.feature_flag`, `platform.feature_flag_targeting`, `platform.document_numbering_scheme`, `platform.document_number_sequence`, `platform.document_number_reservation`, dispatch mechanics, dead-letter replay, command replay, exception queue lifecycle, the effective-dated configuration registry, the feature flag registry, and the document number allocator. Platform provides a reusable `withInbox` transaction boundary, but each consumer owns its inbox table and business effect. This module does not define domain event payloads; `@pss/contracts` validates those before an insert or send.

Approval tables: `platform.approval_type`, `platform.approval_policy`, `platform.approval_level`, `platform.approval_request`, `platform.approval_step`, `platform.approval_delegation`, and `platform.approval_inbox`. Migration `0011_approval_subject_version.sql` adds subject version and a unique `(type, subjectRef, subjectVersion)` request key. `processFinanceApprovalSubmission` and `decideApproval` are acceptance-tested in the Finance and Platform integration suites.

## Does not own

Business aggregates, audit entries, consumer inbox tables, event consumers, operational read models, or any subject row an exception item points at. `ExceptionItem.subject` is a `(domain, type, id)` reference only; Platform never reads or writes the subject's table (DQ-001.NC02).

Platform does not own configuration **evaluation**. `@pss/configuration` turns a configuration row into a value and a flag row into a boolean; Platform owns the rows and the audited writes, and `loadConfigRows`/`loadFlagRows` return data already shaped as that library's inputs. Platform also owns the document number **counter**, not the numbering **format** — see DOC-001 under open decisions.

## Commands

### Command pipeline (ADR-0013)

The single write path for every retriable mutation. `AGENTS.md` 3.6 (idempotent),
14 (audited), and 18 (no duplicate systems) are properties of how a mutation runs,
so they are solved once here instead of per domain.

- `runCommand(pool, key, execute)` opens one transaction, holds the
  `platform.idempotency_key` row, and hands `execute` an `AuditedTransaction`. The
  transaction runner is **not** a parameter, so a mutation cannot commit without an
  audit entry and a retry cannot double-apply. `execute` returns `{ code, body }`:
  the stored response is HTTP-shaped because `platform.idempotency_key` columns are
  `response_code`/`response_body`. The lower-level `withIdempotentCommand` is no
  longer exported, because the runner it accepted made the audit guarantee opt-in
  and all four call sites passed a pass-through.
- `withConnection(pool, transaction, work)` runs a domain function in an audited
  transaction, reusing an open one. This used to be copied into `inventory`, `wms`,
  and `invoicing` as `application/support/with-connection.ts`; those three copies
  are deleted and their 15 call sites repointed here. A domain function takes the
  caller's transaction rather than an optional `client`, so the idempotency row and
  the mutation cannot land in separate commits.
- `runCommandWithoutAudit(pool, key, execute, reason)` covers the two shapes that
  cannot share the caller's transaction: a batch that must stay independent per item
  (`syncOfflineConfirmations`, so one rejected scan becomes `NEEDS_REVIEW` instead of
  discarding a device queue) and operational presence (`heartbeatOperatorSession`,
  where no aggregate changes). `reason` is a mandatory string literal of at least 20
  characters. `scripts/check-command-fitness.mjs` prints every use with its
  justification, so the exemption list is reviewable rather than invisible.
- **The audit count belongs to the transaction, not the invocation.** `runAuditedWork`
  in `@pss/audit` tallies entries in a `WeakMap` keyed by `PoolClient`, so nested
  calls accumulate. A per-invocation counter made the outer guard see zero entries
  for a mutation the inner call had already audited, which would have pushed every
  nested command to open a second connection and lose atomicity with its idempotency
  row. Keying by client is safe because a client is checked out for exactly one
  transaction, so a rolled-back or committed transaction cannot leak a count forward.

Invariants this now enforces structurally:

- A committed mutation has at least one `audit.audit_entry` in the same transaction.
- A retried command replays its stored response rather than re-applying.
- The document-numbering commands share one commit with their idempotency row.
  They previously passed only a `Pool`, so each opened a second connection; a failed
  outer commit left a mutation a retry would re-apply. The same applied to
  `setFeatureFlag` and `setFlagTargeting`, which took no transaction at all; both now
  accept one and the configuration routes thread it, so a flag write and its
  idempotency row commit together.
- A command asked to do something it finds already done **succeeds and is traced**.
  The audit guard rejects a transaction that appended no entry, which is right for a
  forgotten append and wrong for a no-op. Rather than weaken the guard, the no-op
  path appends its own entry: a re-seed of document numbering with a fresh
  idempotency key writes `NUMBERING_SCHEMES_SEED_NOOP` with `created: 0` and returns
  201. `apps/api/tests/doc-numbering.integration.test.ts` covers it, and the test
  fails if the no-op handling is removed — it was found by review, not by the suite.

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

### Configuration registry (PLT-009)

- `proposeConfigValue(pool, input, proposedBy, client?)` writes one effective-dated `platform.config_value` row. It refuses a key outside the generated registry with `CONFIG_KEY_UNKNOWN`, closes the previous value for the same key and scope with `SUPERSEDED` and a `valid_to` (BR03/NC01 — a value is never deleted), and takes the next `revision`. Passing `client` puts the write, its audit entries, and the caller's PLT-006 idempotency record in one commit; the audit requirement holds either way. `requiresOwnerApproval` without an `approvalId` is refused, so a value cannot reach SCHEDULED on an approval that does not exist.
- `loadConfigRows` returns the SCHEDULED/ACTIVE rows a reader hands to `getConfig`. The status filter lives here because the library treats every non-SUPERSEDED status as effective: without it a PENDING_APPROVAL value would be readable.
- `listConfigValues` gives the console its schedule and history; `configGateReport` lists every registered key with `SET`/`KOSONG`/`UNSET` for the phase gate (R05/AC05).
- `registeredConfigKeys` / `assertRegisteredConfigKey` re-derive the key set from the same generated `registryCatalog` the library reads, because Platform cannot import the library today. Replace them with the library's `CONFIG_KEYS`/`assertKnownConfigKey` once it is a dependency.

### Feature flags (PLT-010)

- `setFeatureFlag` upserts the flag's global default, owner, and target removal date. The default is what an unmatched subject evaluates to, so a rollout cannot widen by accident.
- `setFlagTargeting` upserts one rule per (flag, organization, branch, role, user). A rule that is turned OFF is never percentage-gated, so a staged rollout cannot leave part of the population on.
- `loadFlagRows(pool, { key, context })` projects the global default plus every rule whose constrained dimensions match the subject, is unexpired, and contains it in its percentage share. The bucket is `sha256(flagKey:subjectId) % 100`, so the same subject always gets the same decision on every node and after every restart. Only the **narrowest** constrained dimension becomes the projected target: the library's `flagRank` returns the first dimension that *matches* rather than requiring all of them, so projecting several would let a subject satisfy a branch rule on its organization alone.
- `listFeatureFlags`, `listFlagTargeting`, and `staleFeatureFlags` back the console table and the past-target-removal report (AC04).

### Document numbering (DOC-001)

- `reserveDocumentNumber(pool, input, transaction?)` allocates the next ordinal for (scheme, period) and records the reservation in the same transaction. The counter row is locked and incremented in that transaction, so 50 parallel reserves produce 50 distinct, continuous numbers and a rolled-back call releases its ordinal with the rest of the work. A native SEQUENCE was rejected: it is non-transactional, so a rollback would burn a number and leave an unexplainable gap for a `NO_GAP_FISCAL` type. The same `requestKey` returns the identical reservation (R02/AC02) and the replay is still audited.
- `confirmDocumentNumber` moves RESERVED -> CONFIRMED and binds the number to one document; a repeat is a traced replay. `voidDocumentNumber` moves RESERVED -> VOID permanently with the actor and reason (R05); the ordinal stays consumed, so the next reserve moves past it and a voided number is never reissued (BR02/NC02).
- `createNumberingScheme` records pattern, branch code, reset policy, gap policy, and padding. All are optional because GAP-16 has not approved them; an ACTIVE scheme missing any of them is refused rather than tolerated. `seedDraftNumberingSchemes` registers the 18 S3 document types as DRAFT with every unapproved field NULL.
- `numberSequenceUsage` reports used/reserved/voided and the highest ordinal per period, so {used + reserved + voided} equals the range and every gap is explained by a recorded BATAL (R03/AC06).

## Queries

- `listOpenDeadLetters` and `summariseDeadLetters(pool)` give PLT-005.R02 its depth and age per consumer; `outboxDeliveryStats(pool)` gives PLT-004.R05 its pending count, oldest pending event, and dead-letter count.
- `listQueueDefinitions(pool)` is the registry the queue screen and role routing read.
- `listExceptionItems(pool, filter, authorize)` filters by organization, status, queue, branch, overdue, and owner/escalation role **in SQL**, then delegates finer scope (territory, warehouse, own-only) to `authorize` per row. Keyset pagination on `(sla_due_at, id)`.
- `exceptionQueueMetrics(pool)` reports open, overdue, resolved, and resolution-time p50/p95 per queue (DQ-001.R04).
- `loadConfigRows` and `loadFlagRows` are the read projections `@pss/configuration` consumes; `listConfigValues`, `configGateReport`, `listFeatureFlags`, `listFlagTargeting`, `staleFeatureFlags`, `listNumberingSchemes`, and `numberSequenceUsage` back the admin console.

## Events produced and consumed

The outbox transports validated events from the canonical catalog. It is neither the producer of business facts nor an event consumer.

## Tables

`platform.outbox_event` (0001, extended by 0005) stores the validated envelope, event ID, type, aggregate key/version, creation time, publish time, attempt count, next attempt time, last failure code, and the dead-letter pointer. `platform.idempotency_key` (0002) stores scope, request hash, status, compact response, creation time, and expiry; the database enforces at least seven days of retention.

`platform.event_dead_letter` (0005) is the durable dead-letter queue for both stages: `OUTBOX` (the broker would not accept it) and `CONSUMER` (the handler kept failing, or a version gap outlasted its deferrals). It stores the full envelope, failure code and class, attempt count, first/last failure times, the OPEN/REPLAYED/DISCARDED state, and the replay count. PostgreSQL is the home on purpose: a BullMQ failed set is lost whenever Redis is wiped, and PLT-005.BR03 forbids discarding a dead letter automatically. An open dead letter is never deleted by retention.

`platform.queue_definition` (0006) holds the Appendix P registry: code, label, owner roles, escalation roles, SLA unit and default, an optional config-key SLA, permitted action labels, an optional reason-code allow-list, and `dismissible`. `platform.business_calendar_day` (0006) holds the non-working dates, national first then branch-scoped. `platform.exception_item` (0006) is the queue item: organization/branch, queue code, subject reference, owning domain, owner roles as captured at open, escalation roles once overdue, reason code, minimal context, dedupe key, status, assignee, SLA due time, overdue/escalated times, last command error, resolution, dismissal, occurrence count, and version. Migration 0007 seeds the registry from Appendix P verbatim.

`ExceptionTransition`, `ConfigValue`, `FeatureFlag`, and `NumberReservation` transitions are represented by the append-only `audit.audit_entry` trail, not a second table: a duplicate transition log would be a second source of truth for the same fact (AGENTS.md 18).

`platform.config_value` (0004, extended by 0009) adds a reason code, supersede bookkeeping, an `updated_at`, a surrogate `id` on the flag row for the audit trail, and a unique index over the coalesced scope tuple plus `valid_from` so a concurrent pair of proposals cannot both insert for one scope and period. `platform.feature_flag_targeting` (0009) is the per-rule table: organization, branch, role, user, enablement, percentage, priority, expiry, and version, unique over the coalesced target tuple.

`platform.document_numbering_scheme` (0008) holds the document type, scope, effective dating, and the still-unapproved format fields. `platform.document_number_sequence` (0008) is the locked counter, one row per (scheme, period). `platform.document_number_reservation` (0008) is the number itself: document date, business year and month, period key, ordinal, the formatted string (NULL until GAP-16 approves a pattern), request key, status, and the void reason. Two unique indexes carry the guarantee: one over (scope, type, period, ordinal) so a number is never duplicated, and one over (scope, type, requestKey) so a retry returns the same one. Both include VOID rows, which is what makes "a voided number is never reissued" a database guarantee rather than a hope.

All `date` columns are selected with `::text`. node-postgres materialises a `date` as a JavaScript Date at local midnight, so `toISOString()` would shift an Asia/Jakarta business date by the server's UTC offset (AGENTS.md 11).

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
- A configuration value is never deleted; superseding closes the previous row's `valid_to` and marks it SUPERSEDED. An empty value stays empty and reads as `UNSET`; nothing is substituted for it (NC02).
- A PENDING_APPROVAL configuration value is not readable. Reads offer the library only SCHEDULED and ACTIVE rows.
- A scope is read with `(organizationId, branchId, principalId, customerId)`; a null column matches any value and the library ranks the most specific, so a branch value beats an organization one and neither borrows the other's (BR02).
- A configuration read is scoped to one organization. A value written under one tenant is invisible to another.
- An unregistered configuration or flag key is refused on the write path, not only at read time (E2).
- A flag is off unless an administrator turned it on, an expired rule is off, and an evaluation failure is off (BR02/NC02). A rule that switches a feature off is never percentage-gated.
- A flag decision is a pure function of (flag key, subject): the same subject always lands in the same rollout bucket.
- A document number is allocated once and never reissued. A void is permanent, the ordinal stays consumed, and a repeat of a reserve/confirm/void re-reads the same fact and is still audited.
- The sequence period comes from the document's own business date, never the server date (BR05/AC04).
- Numbering is scoped to one (organization, branch, document type, period). A different organization cannot borrow another's counter.

## Dependencies

PostgreSQL `pg`, `@pss/contracts` event, registry, and error-code validation, `@pss/audit` for the audit-enforcing transaction, and Zod input validation. `@pss/configuration` is the intended evaluation dependency for PLT-009/PLT-010 and is **not yet declared** on `@pss/platform`, which is why the row shapes are mirrored here rather than imported. The application layer composes Platform with Audit through their public interfaces. `EventTransport` is an adapter interface; the BullMQ implementation lives in `apps/integration-worker`.

## Open decisions and limits

**PLT-009 (blocked on an approval type and a key classification).**

- The PRD routes a sensitive key to a `config_change` ApprovalRequest and a non-sensitive key straight to SCHEDULED (PLT-009 main flow 1.2, AC03). **Neither half exists.** There is no `config_change` row in `platform.approval_type` (migration 0003 creates the table and seeds nothing), and Appendix N records an owner and a phase gate per key but never says which keys are sensitive. `proposeConfigValue` therefore takes `requiresOwnerApproval` from the caller and **refuses the claim without an `approvalId`**, rather than inventing a sensitivity rule. Registering `config_change` with its levels (Appendix N: `approval.config_change.levels`, KOSONG -> highest level) and recording sensitivity per key would let the two paths be driven by data instead of by the caller. Until then no value can move from PENDING_APPROVAL to SCHEDULED, because nothing approves it.
- PLT-009.BR05 (a finance/tax key change dated into a SOFT_CLOSE/CLOSED accounting period is rejected) is **not implemented**. The accounting period is Finance-owned, and AGENTS.md 3.1 forbids Platform from reading `finance`. It needs a synchronous Finance dependency (a period check) or an event-driven guard; either way it is a Finance decision, not one Platform can make.
- PLT-009.A1 (retroactive values only for keys that allow it) is **not implemented**, for the same reason: "which keys allow retroactive values" is a per-key business rule that the registry does not carry.
- `CONFIG_VALUE_CHANGED` is in the event catalog (Appendix C.8) but has a null producer and aggregate and no registered payload schema, so `appendOutboxEvent` would reject it. The cache-invalidation contract in PLT-009 therefore has no event yet; the audit trail and `loadConfigRows` are what a reader has today. Registering the schema in `packages/contracts` is the fix.
- The seed values from Appendix N (PLT-009.R05) are **not** written. Appendix N marks most of them ASM or KOSONG, and writing an assumption as a live value is exactly the failure the feature exists to prevent. `configGateReport` lists them so each can be filled deliberately.
- `tax.vat_output_rate` and `tax.vat_input_rate` are **not usable keys**. The generated registry carries the Appendix N row as one mangled expression, `"tax.vat_output_rate\` / \`tax.vat_input_rate"`, so neither half is registered and `CONFIG_KEY_UNKNOWN` is raised for both. The catalog generator's handling of that Appendix N cell is the fix; it is in `scripts/`, not here.
- The schema name `config_value` and the table's `organization_id NOT NULL`-less shape come from migration 0004 and are not changed by a forward-only migration.

**PLT-010 (partial).**

- `FEATURE_FLAG_CHANGED` has the same gap as `CONFIG_VALUE_CHANGED`: catalog entry present, producer/aggregate/payload schema absent, so it is not published. Every flag write is audited instead.
- `CONFIG_MANAGE_PERMISSION` in `apps/api/src/config-admin.controller.ts` resolves to the registry's `configuration.*.manage`. `checkAccess` matches codes exactly against a hand-transcribed group table that does not contain that wildcard, so **the configuration write endpoint denies every caller today, including SYSTEM_ADMIN**. That is the fail-closed direction AGENTS.md 15 wants, and it is asserted as such in `apps/api/tests/config-admin.integration.test.ts`, but it does mean the write path is unreachable until `domains/identity` transcribes the grant. `FEATURE_FLAG_UNKNOWN` is used by `@pss/configuration` for the same condition but is not in the Appendix F error registry, so Platform raises the registered `CONFIG_KEY_UNKNOWN` instead.
- The client snapshot endpoint exists as `GET /platform/flags/:key/rows` and returns rows for `evaluateFlag`/the provider, but the **resolved** per-user flag map (PLT-010.TS03, the offline snapshot) is not built, because that needs the `@pss/configuration` dependency and an offline-cache contract that is not in this scope.
- No cache invalidation, no flag retirement job, and no `FEATURE_FLAG_CHANGED` consumer exists.

**DOC-001 (mechanism complete, format unapproved).**

- **GAP-16 is open**: the numbering pattern, padding, gap policy per document type, and the official branch code are not approved. `pattern`, `branch_code`, `gap_policy`, and `padding` are nullable and the seeded schemes leave them NULL; `createNumberingScheme` refuses an ACTIVE scheme that is missing any of them, so `ReserveNumber` never has to guess. `formattedNumber` is null until an operator supplies an approved pattern. **No numbering format and no branch code is invented anywhere in this code.**
- The **official branch code is not in the repository**. DOC-001.BR04 says a branch scope uses the code from the master data, but Platform cannot read `organization`'s table (AGENTS.md 3.1), so the code is supplied on the scheme by whoever holds MDM-001's approved value. Once MDM-001 exposes it, the scheme should reference it rather than store a copy.
- `DOCUMENT_NUMBER_VOIDED` is registered in the catalog (Appendix C.8) with a null producer, aggregate, and payload schema, so the void is recorded in the audit trail but no event is published. Registering the schema unblocks the event.
- The `NO_GAP_FISCAL` reserved-in-a-separate-transaction flow (DOC-001 main flow 3, AC05, TS02) is **not** differentiated from `GAP_ALLOWED`: all reservations run in the caller's transaction, which is the `GAP_ALLOWED` behaviour. The separate-transaction flow needs the gap policy per type (GAP-16) and a timeout sweep driven by `documents.reservation_timeout_minutes` (AC05), which no scheduler runs yet.
- Pattern-length rejection (DOC-001.E1) is not implemented; `NUMBERING_EXHAUSTED` is raised only when the ordinal exceeds what the operator's own `padding` can express, which is a property of registered data rather than an invented limit.
- The number report is per (document type, period) aggregate counts, not a per-number listing (R03 asks for "each number"). A per-number endpoint for auditors is not implemented.
- No cross-domain caller exists yet: invoicing, procurement, and finance have not called `reserveDocumentNumber`, so the "one DB, in-process" claim in DOC-001 main flow 1 is untested against a real owning domain.

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

`tests/command-fitness.test.ts` covers the command pipeline gate: a command through `runCommand` is accepted, an import of `withIdempotentCommand` outside the canonical file is rejected, the canonical file may call it, a fourth per-domain `withConnection` copy is rejected whether imported or defined locally, an `runCommandWithoutAudit` without a literal justification is rejected, one with a justification is reported rather than rejected, and a justification hidden behind an indirection the gate cannot read is rejected. Each rule is exercised against a violating source, not only a compliant one.

`domains/audit/tests/audit-transaction.integration.test.ts` covers the per-transaction audit count (ADR-0013): a nested audited call on the same client satisfies the outer guard and commits its business row, a nested call that appends nothing still rolls the business row back, and a committed transaction's tally does not carry into the next one.

`domains/platform/tests/outbox.integration.test.ts` verifies rollback, event validation, per-aggregate order, and at-least-once duplicate behaviour after a send succeeds but acknowledgement fails.

`domains/platform/tests/event-delivery-reliability.integration.test.ts` covers the registered backoff table, delayed retry, exhaustion into a dead letter that frees the aggregate, failure classification, duplicate suppression, a version gap that defers and then applies once the gap closes, out-of-order exhaustion into one visible dead letter, a handler failure's code/attempts/timestamps, audited replay, replay releasing a dead-lettered outbox row, audited discard with a mandatory reason, DLQ depth/age summary, and both retention helpers.

`tests/integration/event-pipeline.integration.test.ts` runs the real PostgreSQL + BullMQ path: an audited delivery projected once and tolerant of replay, a worker that dies mid-batch and is replaced without loss or duplication, and a permanently failing consumer that ends in a dead letter, is audited on replay, and then projects exactly once.

`domains/platform/tests/exception-queue.integration.test.ts` covers the Appendix P seed, `QUEUE_UNKNOWN`, the working-day SLA including a branch holiday and a config override, the fail-closed queues, dedupe under concurrency, reopen after resolution, claim/fail/release/resolve, the owning-domain rule, the audit trail per transition, refusal to dismiss, role and branch scope filtering, escalation and re-run safety, per-queue metrics, and the 100k active-item query.

`domains/platform/tests/inbox.integration.test.ts` and `domains/platform/tests/approval.integration.test.ts` cover duplicate delivery, rollback, and approval idempotency.

`domains/platform/tests/config-admin.integration.test.ts` covers effective-dated and most-specific-scope resolution, supersede-without-delete, a KOSONG value reading as UNSET with nothing substituted, an unregistered key, a missing approval, an inverted validity, cross-organization isolation, the audit trail for both a proposal and its supersede, the ASM/KOSONG/UNSET gate report, per-branch flag targeting, a deterministic percentage rollout that actually splits a population and honours 0%, an expired rule reading as off, the stale-flag report, and the same flag decision through `evaluateFlag` and the OpenFeature provider.

`domains/platform/tests/document-numbering.integration.test.ts` covers the DRAFT seed for all 18 S3 types, the refusal to activate a half-configured scheme, **50 parallel reservations producing 50 distinct continuous numbers**, a retried `requestKey` returning the same number, a voided number never being reissued, a void recording its actor and reason, confirmation, period selection from the document date across YEARLY/MONTHLY/NEVER, per-branch and per-organization isolation, and the sequence report explaining every ordinal.

`apps/api/tests/config-admin.integration.test.ts` and `apps/api/tests/doc-numbering.integration.test.ts` cover the HTTP boundary: the missing `Idempotency-Key`, malformed bodies, unauthenticated callers, a body-supplied `organizationId` being refused rather than trusted, the permission gate (asserted to deny today, which is the measured behaviour), the effective-dated rows endpoint, the stale-flag report, the GAP-16 activation refusal, the DRAFT seed over HTTP, reserve/confirm/void over HTTP, and a re-seed under a fresh idempotency key returning 201 with created 0 rather than failing the audit guard.
