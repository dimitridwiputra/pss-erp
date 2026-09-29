# Runbook: outbox stall and dead-letter backlog

- **Owner:** Platform
- **Alerts:** `pss-<env>-outbox-lag` (GCP alert policy, `modules/governance`)
- **Why this exists:** the outbox dispatcher is a poller. Nothing about a stalled
  dispatcher is visible to a user; events simply accumulate in
  `platform.outbox_event` until something notices. This is the AGENTS.md §3.7
  "nothing silently disappears" failure in its most literal form.

## What "stalled" means

`oldest_pending_seconds` — the age of the oldest `platform.outbox_event` row that has
not been dispatched — exceeds 300 seconds. The metric is defined by `@pss/observability`;
until its exporter ships (F0-02 / OD-185), the alert exists but will not fire, so
during that window this check must be run by hand.

## Manual check, valid today

```sql
SELECT
  count(*) FILTER (WHERE dispatched_at IS NULL)                          AS pending,
  now() - min(occurred_at) FILTER (WHERE dispatched_at IS NULL)          AS oldest_pending,
  count(*) FILTER (WHERE dispatched_at IS NULL AND attempts >= 5)        AS failing_repeatedly
FROM platform.outbox_event;
```

If `pending` is growing, the dispatcher is not running. Check in this order, cheapest
first:

1. **Is the worker up?** The outbox lives in the BullMQ queue, and the dispatcher runs
   inside `integration-worker`. On Cloud Run it must have `min_instance_count >= 1`;
   a scaled-to-zero worker stops draining and accumulates events silently. Terraform
   enforces this, so if the value is wrong the environment drifted.
2. **Is Redis reachable?** Events are already durable in the outbox table, so a Redis
   outage stalls delivery without losing anything. Confirm with
   `redis-cli -h <host> ping`; expect `PONG`.
3. **Is the consumer failing?** A consumer that throws repeatedly moves work to the
   dead-letter path rather than retrying forever. Check the DLQ before assuming the
   dispatcher is at fault — a red outbox with a full DLQ is a consumer bug, not a
   dispatcher bug.

## Triage order

| Symptom | Likely cause | Action |
|---|---|---|
| pending grows, attempts stays 0 | dispatcher not running | start `integration-worker`; check `min_instance_count` |
| pending grows, attempts climbs | consumer throwing | read the DLQ, fix the consumer, then replay |
| pending stable but oldest_pending grows | one poison event blocking the ordered queue | move that event to the DLQ, then replay it deliberately |
| pending = 0, lag alert still firing | metric stuck, not data stuck | restart the exporter; verify against the query above before acting |

## Recovering

Replay is a deliberate, audited action, not a retry. A replay re-delivers an event to
its consumer; the consumer's own inbox dedupe means a replay of an already-applied
event is a no-op rather than a duplicate effect. That safety property is the reason
replay is safe to run more than once.

Before replaying, establish which case you are in:

- **Redelivering a dead-lettered event after a fix.** Replay it. The inbox receipt
  was never written, so the effect has not been applied.
- **Redelivering an event whose effect already applied.** The inbox refuses it as a
  duplicate. No action needed; this is the correct outcome, not a failure.

Do not delete rows from `platform.outbox_event` to "clear" the queue. That destroys
the only durable copy of an event and cannot be undone.

## Escalation

If the backlog is not explained within one business day, or if any event in the DLQ
involves a financial posting, stop and escalate to Engineering. Do not attempt a
bulk replay of financial events without Finance present: an ordering mistake in
posting replay is harder to unwind than the outage.
