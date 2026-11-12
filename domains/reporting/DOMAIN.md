# reporting domain

Status: two consumers of the canonical event backbone are implemented (delivery order status, approval status) plus inbox retention. The RPT-001 metric registry and the rest of §69 are not built.

## Purpose

Project canonical events into read models for operational reporting, using each event exactly once. Reporting is a consumer: it never writes the aggregate it reports on.

## Owns

`reporting.inbox_event` (its own dedup receipts) and `reporting.delivery_order_status`. Also owns the retention of its own inbox, because Platform must not write another schema's table (AGENTS.md 3.1).

## Does not own

`sales.delivery_order`, `platform.approval_request`, or any other source aggregate. It stores the event's projection of those facts, never the facts themselves. It does not own the metric definitions RPT-001 is to define.

## Commands

- `projectDeliveredOrder(pool, event)` handles `DELIVERY_ORDER_DELIVERED` through `withInbox`. The inbox receipt and the projection commit together, and the upsert is guarded by `aggregate_version`, so a redelivered or out-of-order older event cannot move the read model backwards. Returns the `InboxResult`.
- `projectApproval(pool, event)` handles both v1 and v2 `APPROVAL_REQUESTED` / `APPROVAL_DECIDED` with the same version guard. The v2 subject-version payload remains owned by Platform and the business effect by its subject domain.
- `deleteExpiredInboxReceipts(pool, retentionDays = 400)` removes receipts only past the archive window. It refuses a smaller window: PLT-005.R05 requires inbox retention to be at least the replay archive retention, so a shorter one would let a replayed event be reprocessed as new.

## Queries

None yet; the read models are written but not exposed through a query API.

## Events produced and consumed

Consumes `DELIVERY_ORDER_DELIVERED`, `APPROVAL_REQUESTED`, and `APPROVAL_DECIDED`. Produces no events.

## Tables

`reporting.inbox_event` via migration 0001, keyed by `(consumer_name, event_id)`. `reporting.delivery_order_status` and `reporting.approval_status` are the projections, each carrying `aggregate_version` and `source_event_id`.

## Invariants

- One effect per event ID per consumer, and the effect commits with the receipt.
- A projection never regresses: an update applies only when its `aggregate_version` is greater than the stored one.
- A receipt is never deleted while the event it proves is still replayable.

## Dependencies

`pg`, `@pss/contracts` payload schemas, and `@pss/platform` for the inbox boundary and the archive-retention policy value. `apps/integration-worker` is the transport; Reporting does not talk to Redis.

## Open decisions

- No ordering contract is declared yet. `withInbox` supports an out-of-order deferral, but neither projection uses it: `DELIVERY_ORDER_DELIVERED` is terminal for the status this model holds, so a missing predecessor would be invisible rather than deferred. Decide per event type whether a gap should defer or be accepted.
- RPT-001 canonical metric definitions, attribution, and the DW loader that must agree with this read model are not started.
- The 24-hour polling interval in `apps/integration-worker` is a placeholder; the freshness SLA for each connector is KOSONG in Appendix N (`integration.freshness_sla_minutes`).

## Acceptance tests

`tests/integration/event-pipeline.integration.test.ts` drives both projections through the live outbox, BullMQ, and inbox path, including a worker restart mid-batch and an audited dead-letter replay.
