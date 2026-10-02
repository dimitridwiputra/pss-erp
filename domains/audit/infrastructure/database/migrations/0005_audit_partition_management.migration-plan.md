# 0005_audit_partition_management — migration plan

## Why this migration is classified destructive

It creates two functions. One of them contains a `DROP TABLE`, and `scripts/check-database.mjs` reads
the SQL text rather than the statement's effect, so a plan is required even though this migration
alters no existing table and removes no existing row.

The `DROP` is confined to `audit.drop_month_partition(text)`, whose entire purpose is to remove one
monthly partition of `audit.audit_entry` after the archive has confirmed its contents. It cannot be
reached by a migration run. It is called only by `archiveExpiredAuditPartitions`, and only after
`decidePartitionDisposition` has established, for that partition, that no row is inside its class's
hot window, that the month has closed, and that every archived page came back with a matching
partition, cursor, row count and digest. `0006_audit_entry_partition_swap.sql` — the migration that
actually moves data — carries its own plan.

## Backfill

None. No table is altered and no row is written. Both functions are new and operate on whatever
partitions exist when they are eventually called.

`ensure_month_partitions` is additive by construction: it creates only the months between its two
bounds that do not already exist, and never widens an existing bound. Its existence check is by name
rather than `CREATE TABLE IF NOT EXISTS`, so two partitions claiming one month is a loud error rather
than a silently skipped definition. Running it twice creates nothing the second time.

## Compatibility

- `CREATE OR REPLACE FUNCTION` on a function that does not yet exist is a plain create, so a fresh
  database and a migrated one converge on the same state.
- No concurrent session is affected at migration time. The only behavioural change is that a write
  into a month with no partition still raises `no partition of relation found for row`; that was
  already true after `0003`, and provisioning ahead of time is what this function exists for.
- Both functions are schema-qualified throughout and resolve no unqualified relation names, so they
  behave the same under any `search_path`. `drop_month_partition` in particular takes the name as a
  bound parameter and quotes it with `format('%I')` rather than reading `search_path`.
- The existing write path is untouched. `archiveExpiredAuditPartitions` and `ensureAuditPartitions`
  are new in this release.

## Rollback

```sql
DROP FUNCTION IF EXISTS audit.drop_month_partition(text);
DROP FUNCTION IF EXISTS audit.ensure_month_partitions(regclass, date, date);
```

Rolling back drops the two functions and nothing else.

**Partitions that `ensure_month_partitions` already created are left in place**, and that is the safe
direction: a partition can only be removed by `drop_month_partition`, and a database without that
function cannot release one. An empty partition costs one relation and no rows. Removing them by hand
is optional and is not part of the rollback.

No rollback path can lose a row. The only `DROP` in this migration is reachable for a partition whose
rows are already archived, and removing the function that performs it makes the drop unreachable
rather than unguarded.
