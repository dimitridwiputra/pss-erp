-- OD-19: the operational half of a monthly-partitioned audit table.
--
-- `0003_audit_entry_partitioning_prereq.sql` created four partitions by hand and explained why there
-- is no DEFAULT: an unbounded catch-all is how audit entries go missing. That is still true, and it has
-- a consequence this function exists to solve: because there is no DEFAULT, an application write into
-- a month with no partition RAISES. So partitions have to be created ahead of time, and doing that by
-- hand every month is exactly the sort of convention that fails silently the first time someone is on
-- leave.
--
-- The function is the single place that knows the partition naming rule, so the swap migration, the
-- retention job and any future tooling all agree on what a partition is called. It is deliberately
-- narrow: it creates only what is missing, it never drops, and it never widens a bound.
--
-- WHY A `timestamptz`-free signature. The bounds are built from a `date`, so the partition edges land
-- on midnight of a calendar month in the SERVER's time zone. That is a real dependency: a server whose
-- time zone changes reinterprets the edges. It is accepted rather than hidden because PostgreSQL stores
-- partition bounds as instants and the retention cutoff is month-aligned too, so the two agree by
-- construction. `docs/DOMAIN.md` records it as a limit rather than a decision.

CREATE OR REPLACE FUNCTION audit.ensure_month_partitions(
  p_parent regclass,
  p_from date,
  p_through date
) RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_month date;
  v_upper date;
  v_name text;
  v_created integer := 0;
BEGIN
  -- An inverted or empty range is a caller mistake, not a request to do nothing: returning 0 here
  -- would let a mistyped window look like a successful run.
  IF p_through < p_from THEN
    RAISE EXCEPTION 'audit partition range %..% is inverted', p_from, p_through;
  END IF;

  v_month := date_trunc('month', p_from)::date;
  WHILE v_month <= p_through LOOP
    v_upper := (v_month + interval '1 month')::date;
    v_name := format('audit_entry_%s', to_char(v_month, 'YYYY_MM'));

    -- Existence is checked by NAME and not by a conditional create. A name check misses a
    -- range that some other partition already covers, and then the CREATE raises "would overlap",
    -- which is the correct outcome: two partitions claiming one month is a schema error an operator
    -- must see, and `IF NOT EXISTS` would instead skip the conflicting definition and hide it.
    IF to_regclass(format('audit.%I', v_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        v_name, p_parent, v_month, v_upper);
      v_created := v_created + 1;
    END IF;

    v_month := v_upper;
  END LOOP;

  RETURN v_created;
END;
$fn$;

COMMENT ON FUNCTION audit.ensure_month_partitions(regclass, date, date) IS
  'Creates the missing monthly partitions of p_parent between p_from and p_through inclusive, by name. '
  'Returns how many it created. Never drops, never widens a bound, and never attaches a DEFAULT '
  'partition. Called by 0006 to cover the existing rows and the current month, and by '
  'domains/audit/src/application/ensure-audit-partitions.ts to keep the partition set ahead of the writes.';

-- WHY THE DROP GOES THROUGH A FUNCTION. `DROP TABLE` cannot take a bound parameter for an identifier,
-- so the obvious implementation interpolates a name that came from pg_class. A function moves the
-- interpolation inside `format('%I')` and adds two checks an interpolated statement cannot have: the
-- name must look like a month partition this domain creates, and the relation must actually be a
-- partition of `audit.audit_entry`. A bug in the caller's catalogue query therefore cannot reach a
-- table that is not an audit partition, and a name that looks like a partition but is not one is
-- refused rather than dropped.
CREATE OR REPLACE FUNCTION audit.drop_month_partition(p_name text)
RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_parent regclass;
BEGIN
  IF p_name !~ '^audit_entry_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'refusing to drop %: not a monthly audit partition name', p_name;
  END IF;

  SELECT i.inhparent INTO v_parent
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE c.oid = to_regclass(format('audit.%I', p_name));

  IF v_parent IS DISTINCT FROM 'audit.audit_entry'::regclass THEN
    RAISE EXCEPTION 'refusing to drop audit.%: it is not a partition of audit.audit_entry', p_name;
  END IF;

  EXECUTE format('DROP TABLE audit.%I', p_name);
  RETURN true;
END;
$fn$;

COMMENT ON FUNCTION audit.drop_month_partition(text) IS
  'Drops one monthly partition of audit.audit_entry, refusing any name that is not one. This is the '
  'ONLY supported way to remove a partition; domains/audit/src/domain/rules/partition-retention-decision.ts '
  'decides whether a drop is permitted, and this function is the last check that the target is what it claims to be.';
