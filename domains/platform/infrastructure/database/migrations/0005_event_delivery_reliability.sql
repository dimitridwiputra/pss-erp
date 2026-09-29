-- PLT-004/PLT-005 delivery reliability: bounded retry with backoff, a durable dead-letter
-- path, and the retention keys those two need.
--
-- Delivery is at-least-once, so PostgreSQL (not Redis) is the durable home for a dead letter:
-- a BullMQ failed set is lost whenever Redis is wiped, and PLT-005.BR03 forbids discarding a
-- dead letter automatically. The single table serves both stages so "the event is stuck" has
-- exactly one record: OUTBOX (the broker would not accept it) and CONSUMER (the handler kept
-- failing, or the aggregate version gap outlasted its deferral budget).

ALTER TABLE platform.outbox_event
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_failure_code text,
  ADD COLUMN IF NOT EXISTS last_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_letter_id uuid;

-- The dispatcher polls on readiness, not on creation time: a row in backoff is not ready yet.
CREATE INDEX IF NOT EXISTS outbox_event_ready_idx
  ON platform.outbox_event (next_attempt_at, created_at, event_id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE IF NOT EXISTS platform.event_dead_letter (
  id uuid PRIMARY KEY,
  stage text NOT NULL CHECK (stage IN ('OUTBOX', 'CONSUMER')),
  consumer_name text,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  organization_id uuid,
  branch_id uuid,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  failure_code text NOT NULL,
  failure_class text NOT NULL CHECK (failure_class IN ('TRANSIENT', 'PERMANENT')),
  failure_message text,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REPLAYED', 'DISCARDED')),
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  replayed_at timestamptz,
  replayed_by uuid,
  discarded_at timestamptz,
  discarded_by uuid,
  discard_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT dead_letter_stage_consumer CHECK ((stage = 'CONSUMER') = (consumer_name IS NOT NULL)),
  CONSTRAINT dead_letter_discard_needs_reason CHECK (status <> 'DISCARDED' OR discard_reason IS NOT NULL),
  CONSTRAINT dead_letter_terminal_state CHECK (
    (status = 'OPEN' AND replayed_at IS NULL AND discarded_at IS NULL)
    OR (status = 'REPLAYED' AND replayed_at IS NOT NULL AND discarded_at IS NULL)
    OR (status = 'DISCARDED' AND discarded_at IS NOT NULL AND replayed_at IS NULL)
  )
);

-- One open dead letter per event per consumer: a redelivered event updates the row it already
-- has instead of stacking a second one (AGENTS.md 3.6, PLT-005.BR03).
CREATE UNIQUE INDEX IF NOT EXISTS event_dead_letter_active_idx
  ON platform.event_dead_letter (event_id, coalesce(consumer_name, '')) WHERE status = 'OPEN';
-- PLT-005.R02: DLQ age and depth per consumer.
CREATE INDEX IF NOT EXISTS event_dead_letter_open_idx
  ON platform.event_dead_letter (consumer_name, stage, first_failed_at) WHERE status = 'OPEN';
-- Retention scan: terminal rows only, oldest last-touched first.
CREATE INDEX IF NOT EXISTS event_dead_letter_terminal_idx
  ON platform.event_dead_letter (status, last_failed_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_event_dead_letter_fk' AND conrelid = 'platform.outbox_event'::regclass
  ) THEN
    ALTER TABLE platform.outbox_event
      ADD CONSTRAINT outbox_event_dead_letter_fk
      FOREIGN KEY (dead_letter_id) REFERENCES platform.event_dead_letter (id);
  END IF;
END;
$$;
