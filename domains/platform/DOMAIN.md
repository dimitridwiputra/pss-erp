# Platform domain

Status: PLT-004 outbox, PLT-005 inbox wrapper, and PLT-006 command idempotency foundations implemented; their worker adapters remain planned.

## Purpose

Provide shared persistence and delivery infrastructure for canonical domain events. A domain keeps authority over the business fact and event content; Platform owns transport and delivery state.

## Owns

`platform.outbox_event`, `platform.idempotency_key`, dispatch mechanics, and command replay. Platform provides a reusable `withInbox` transaction boundary, but each consumer owns its inbox table and business effect. This module does not define domain event payloads; `@pss/contracts` validates those before an insert or send.

## Does not own

Business aggregates, audit entries, consumer inbox tables, event consumers, or operational read models.

## Commands

- `appendOutboxEvent(client, event)` validates the event type, version, producer, aggregate, and implemented payload schema, then inserts into the caller's active transaction. Call with the same client as the domain mutation and audit entry.
- `dispatchPendingEvents(pool, transport, limit)` selects pending events with row locks, sends one event at a time, then marks it dispatched in the same transaction. Failure leaves the event pending. A crash after transport accepts a message can cause a duplicate; consumers need PLT-005 inbox deduplication.
- `withIdempotentCommand(pool, key, runTransaction, execute)` scopes a key by organization, identity, and command. The application supplies an audit-enforcing transaction runner from the Audit public interface; Platform does not import Audit. It writes `IN_PROGRESS`, executes the command, and stores a compact response as `COMPLETED` with the effects in the same commit. Same-key/same-hash retries replay that response; different hashes fail. A technical failure rolls back the key and all effects.
- `deleteExpiredIdempotencyKeys(pool)` removes only keys whose seven-day minimum retention has elapsed. It needs a daily job before PLT-006 can be complete.
- `withInbox(pool, inbox, event, handler)` validates a registered event and opens one transaction. The consumer-owned `inbox.reserve` callback inserts its `(consumer_name, event_id)` receipt using the supplied client; the handler receives that same client for its effect. Duplicate delivery skips the handler; a handler or commit failure rolls back both receipt and effect. The consumer must acknowledge the queue message only after this function returns.

## Queries

The pending index supports dispatcher polling. No public read API exists yet.

## Events produced and consumed

The outbox transports validated events from the canonical catalog. It is neither the producer of business facts nor an event consumer.

## Tables

`platform.outbox_event` via migration 0001 stores the validated envelope, event ID, type, aggregate key/version, creation time, and publish time. The event ID is unique. Pending rows have no publish time. `platform.idempotency_key` via migration 0002 stores scope, request hash, status, compact response, creation time, and expiry; the database enforces at least seven days of retention.

Each consuming domain must create its own `<schema>.inbox_event(consumer_name text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer_name, event_id))` in that domain's migration. Platform has no cross-domain inbox table. The current integration test creates a `reporting` fixture schema to prove the boundary; no live consumer is registered yet.

## Invariants

- A rolled-back domain transaction leaves no outbox event.
- The dispatcher does not bypass an older pending event for the same aggregate.
- A failed transport call leaves the event pending for retry.
- Delivery is at least once; consumers must deduplicate by `eventId`.
- Concurrent retries with one scoped key execute once. Replay returns the stored status and body. A changed hash is rejected.
- The application must supply an audit-enforcing runner before using this command wrapper for a mutation. Audit, outbox, idempotency response, and the owning mutation can share its one `pg` client. The cross-domain integration test uses `runAuditedWork` and proves a missing audit entry rolls everything back.
- A consumer handler must write all of its effects with the supplied `PoolClient`. The inbox receipt and effect commit together. A duplicate event ID is scoped by consumer name. The consumer's queue ack follows a successful return, never precedes it.

## Dependencies

PostgreSQL `pg`, `@pss/contracts` event validation, and Zod command key validation. The application layer composes Platform with Audit through their public interfaces. `EventTransport` is an adapter interface; the BullMQ implementation and consumer registry are not yet wired.

## Open decisions and limits

PLT-004 remains partial: no BullMQ adapter, scheduled process, consumer fan-out registry, archive/replay, retention, lag metrics, throughput test, or operational alert. These require the S3–S4 platform work and approved configuration. A DB transaction is held during the transport call in this initial dispatcher; the production dispatcher must use a bounded lease/ack pattern before higher throughput is claimed.

PLT-006 remains partial: the NestJS interceptor, generated required-key endpoint list, request hash canonicalization at the API boundary, privacy review of stored response bodies, daily cleanup scheduling, and hit/conflict metrics are pending. Callers must supply a normalized request hash and a compact response without unnecessary personal data.

PLT-005 remains partial: no live consumer, BullMQ retry/backoff, out-of-order delay, dead-letter queue, replay audit, retention policy, lag metrics, alert, or fitness check is wired. The wrapper and PostgreSQL test cover only duplicate delivery and rollback; they do not establish exactly-once effects for handlers that use a different connection or call external systems.

## Acceptance tests

`tests/outbox.integration.test.ts` uses an isolated PostgreSQL database to verify rollback, event validation, retry when transport fails, per-aggregate order, and at-least-once duplicate behavior after a send succeeds but acknowledgement fails.

The root `tests/integration/idempotency.integration.test.ts` composes Platform and Audit and verifies 50 concurrent requests execute once, scoped identity and hash conflicts, technical rollback, audit enforcement, six-day offline replay, and expiry cleanup in an isolated PostgreSQL database.

`tests/inbox.integration.test.ts` verifies five simultaneous copies cause one effect, a failed handler rolls back receipt and effect and can retry, and separate consumers have separate receipts. The remaining PLT-005 AC/TS cases require the live queue and consumer.
