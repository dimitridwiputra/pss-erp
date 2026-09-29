-- DQ-001 exception queue foundation (ADR-0022, DEC-110). Platform owns the queue lifecycle;
-- the subject's owning domain resolves it through its own command boundary. Only Appendix P
-- queue codes are seeded here; no queue, label, role, or action is invented.
--
-- Item transitions are audited in the append-only audit.audit_entry trail, so this file adds
-- no duplicate transition table (AGENTS.md 18).

CREATE TABLE IF NOT EXISTS platform.queue_definition (
  code text PRIMARY KEY CHECK (code ~ '^Q-[A-Z_]+$'),
  label text NOT NULL,
  -- Appendix P "Owner role". More than one role when the registry names more than one.
  owner_roles text[] NOT NULL CHECK (array_length(owner_roles, 1) >= 1),
  -- Appendix P "Eskalasi". Empty where the registry writes "—" or names no single role.
  escalation_roles text[] NOT NULL DEFAULT '{}',
  -- One of the four units for sla_value. A queue whose registry SLA is a duration sets it.
  sla_unit text NOT NULL CHECK (sla_unit IN ('MINUTES', 'HOURS', 'DAYS', 'BUSINESS_DAYS')),
  -- The Appendix P duration. NULL means the registry named no duration, so the queue is
  -- registered but not openable until its owner registers one; Platform never guesses.
  sla_value integer CHECK (sla_value IS NULL OR sla_value > 0),
  -- Appendix P names a config key instead of a duration for a few queues. NULL means the
  -- standard `exception.<queue>.sla` override applies (Appendix P, registry preamble).
  sla_config_key text,
  -- Appendix P "Aksi yang diizinkan". Labels only: the command behind each label is owned by
  -- the subject domain, never by Platform (DQ-001.BR05).
  permitted_actions text[] NOT NULL DEFAULT '{}',
  -- Appendix P "Pemicu" states a trigger condition, not an enumerated reason-code set, so no
  -- queue is seeded with a list. An empty list accepts any well-formed code; a filled one
  -- restricts that queue to exactly those codes.
  reason_codes text[] NOT NULL DEFAULT '{}',
  dismissible boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.business_calendar_day (
  id uuid PRIMARY KEY,
  calendar_date date NOT NULL,
  -- NULL scope is the national default; a branch row overrides it.
  organization_id uuid,
  branch_id uuid,
  is_working boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('NATIONAL_HOLIDAY', 'BRANCH_CLOSED', 'OPEN')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS business_calendar_day_scope_idx
  ON platform.business_calendar_day (
    calendar_date,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS platform.exception_item (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid,
  queue_code text NOT NULL REFERENCES platform.queue_definition (code),
  subject_domain text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  -- The domain that opened the item owns the subject, and is the only domain allowed to
  -- resolve it (DQ-001.NC01). Copied from the caller, not guessed from the queue.
  owner_domain text NOT NULL,
  -- Ownership as it was when the item was opened, so a later registry change cannot silently
  -- hand an open item to a different role (DQ-001.BR06).
  owner_roles text[] NOT NULL,
  -- Stays empty until the item is actually overdue. DQ-001.BR06 widens visibility to the
  -- escalation role only after escalation, so seeding it here would hand an on-time item to
  -- a role that has no business seeing it yet.
  escalation_roles text[] NOT NULL DEFAULT '{}',
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  dedupe_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED')),
  assignee_id uuid,
  sla_due_at timestamptz NOT NULL,
  overdue_at timestamptz,
  escalated_at timestamptz,
  -- DQ-001.AC04: a failed subject command leaves the item in progress and shows why.
  last_error_message text,
  resolution_command text,
  resolution_result text,
  resolved_at timestamptz,
  resolved_by uuid,
  dismiss_reason text,
  dismissed_at timestamptz,
  dismissed_by uuid,
  -- How many times the same dedupe key has re-fired since the item was opened.
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exception_item_terminal_state CHECK (
    (status = 'OPEN' AND assignee_id IS NULL AND resolved_at IS NULL AND dismissed_at IS NULL)
    OR (status = 'IN_PROGRESS' AND assignee_id IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL)
    OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolution_command IS NOT NULL)
    OR (status = 'DISMISSED' AND dismissed_at IS NOT NULL AND dismiss_reason IS NOT NULL)
  )
);

-- DQ-001.BR02: one active item per (queue, dedupe key). A re-fire updates that item.
CREATE UNIQUE INDEX IF NOT EXISTS exception_item_active_dedupe_idx
  ON platform.exception_item (queue_code, dedupe_key) WHERE status IN ('OPEN', 'IN_PROGRESS');
-- DQ-001.R06: the work list, ordered by SLA, scoped by organization and branch.
CREATE INDEX IF NOT EXISTS exception_item_worklist_idx
  ON platform.exception_item (organization_id, sla_due_at, id) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS exception_item_branch_worklist_idx
  ON platform.exception_item (organization_id, branch_id, sla_due_at, id)
  WHERE status IN ('OPEN', 'IN_PROGRESS');
-- DQ-001.NC03: a role outside owner and escalation scope never matches.
CREATE INDEX IF NOT EXISTS exception_item_owner_roles_idx
  ON platform.exception_item USING gin (owner_roles) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS exception_item_escalation_roles_idx
  ON platform.exception_item USING gin (escalation_roles) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS exception_item_overdue_idx
  ON platform.exception_item (sla_due_at, id) WHERE status IN ('OPEN', 'IN_PROGRESS') AND overdue_at IS NULL;
-- DQ-001.R04 resolution-time metrics per queue.
CREATE INDEX IF NOT EXISTS exception_item_resolved_idx
  ON platform.exception_item (queue_code, resolved_at) WHERE status = 'RESOLVED';
CREATE INDEX IF NOT EXISTS exception_item_subject_idx
  ON platform.exception_item (subject_domain, subject_type, subject_id, created_at DESC);
