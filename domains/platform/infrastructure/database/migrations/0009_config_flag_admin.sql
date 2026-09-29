-- PLT-009 / PLT-010: what an auditable administrative write needs beyond migration 0004.
--
-- `platform.config_value` (0004) has no reason code, no supersede bookkeeping, and no
-- uniqueness guarantee, so a concurrent pair of proposals for the same key and scope could
-- both insert and neither would know which superseded which. PLT-009.BR03 requires a value to
-- be SUPERSEDED, never deleted, and PLT-009.BR02 requires deterministic scope resolution, so
-- the scope tuple needs one active row per (key, scope, valid_from).
--
-- `platform.feature_flag` (0004) has a single `targeting` jsonb and no per-target rows, so
-- it cannot express PLT-010's org/branch/role/user targeting or a staged rollout. This adds
-- `platform.feature_flag_targeting`: one row per targeting rule, each with its own enablement,
-- percentage, and expiry. The flag row keeps the global default and the owner registry.
--
-- Percentage rollout is a deterministic bucket on (flag key, subject id) rather than a random
-- draw, so the same subject always gets the same decision (PLT-010.AC01 / NC02). `expires_at`
-- is evaluated by `@pss/configuration`'s provider, which drops an expired row, so an expired
-- rule resolves to the fail-closed default instead of enabling anything.

-- `platform.feature_flag` (0004) is keyed by the flag name because that is what code reads,
-- but `audit.audit_entry.entity_id` is a uuid. A surrogate id is added rather than deriving a
-- uuid from the flag name, which would tie the audit identity to a renameable string. The
-- backfill UPDATE runs before the DEFAULT is attached, so replaying this file is a no-op.
ALTER TABLE platform.feature_flag
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE platform.feature_flag SET id = gen_random_uuid() WHERE id IS NULL;

ALTER TABLE platform.feature_flag
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_id_uniq ON platform.feature_flag (id);

ALTER TABLE platform.config_value
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- One live row per (key, scope, valid_from). The scope columns are nullable by design, so they
-- are coalesced to the nil UUID; a NULL would make the index treat distinct scopes as equal.
CREATE UNIQUE INDEX IF NOT EXISTS config_value_scope_period_uniq
  ON platform.config_value (
    key,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(principal_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
    valid_from
  );

ALTER TABLE platform.feature_flag
  ADD COLUMN IF NOT EXISTS percentage integer,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- The migration runner replays every file, so a bare ADD CONSTRAINT would fail on the second run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feature_flag_percentage_range'
      AND conrelid = 'platform.feature_flag'::regclass
  ) THEN
    ALTER TABLE platform.feature_flag
      ADD CONSTRAINT feature_flag_percentage_range
      CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS platform.feature_flag_targeting (
  id uuid PRIMARY KEY,
  flag_key text NOT NULL REFERENCES platform.feature_flag(key),
  -- org / branch / role / user targeting. A row with an empty target is the global rule.
  organization_id uuid,
  branch_id uuid,
  role_code text,
  user_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  percentage integer CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
  -- Higher wins when two rules match the same subject (PLT-010 registry priority).
  priority integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

-- A subject matches at most one rule per flag, so the most specific rule is unambiguous
-- without relying on evaluation order.
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_targeting_uniq
  ON platform.feature_flag_targeting (
    flag_key,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(role_code, ''),
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS feature_flag_targeting_lookup_idx
  ON platform.feature_flag_targeting (flag_key, updated_at DESC);
