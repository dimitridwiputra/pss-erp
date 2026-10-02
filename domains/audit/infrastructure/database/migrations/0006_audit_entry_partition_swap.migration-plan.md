# Migration plan — 0006_audit_entry_partition_swap

Applies `PLT-002.AC02`. The migration is destructive: it drops `audit.audit_entry` after copying every
row into the prepared partitioned table.

## Backfill

`audit.audit_entry` is copied into `audit.audit_entry_partitioned` with an explicit column list, so
the copy is positional only in the sense that both column lists are written out; a column added to one
side and not the other is a compile error, not a silent truncation.

Before the copy, partitions are created for every month the existing rows span, plus the current month
and the next. `0003` created 2026-10 through 2027-01 and deliberately attached no DEFAULT partition,
so a range with no partition makes the INSERT fail loudly instead of routing the row into an
unbounded catch-all. On an empty database the range is the current month and the next.

After the copy, two assertions run in the same transaction:

- the destination row count equals the source row count;
- no row's `retention_class` differs between source and destination.

Either failure raises, which rolls the whole migration back, leaving `audit.audit_entry` as it was.
The second assertion is the one that matters for OD-19: a row that lost its class on the way across
would be archived under a period nobody chose.

At the projected volume the copy is a one-off cost of the full hot table (~115 GB at 24 months). It is
not incremental and has no resume: if it fails, it is re-run from the start, which is acceptable
because the source is untouched until step 4.

## Compatibility

The write path is unchanged. `appendAuditEntry` inserts the same column set as before, plus
`retention_class`, which exists on both sides of the swap.

Behaviour changes a caller can observe:

| Before | After | Why |
|---|---|---|
| `audit.audit_entry` is a plain heap | partitioned by RANGE on `occurred_at` | the swap OD-19 authorised |
| `tableoid` of a row is `audit.audit_entry` | `audit.audit_entry_YYYY_MM` | PostgreSQL reports the physical partition |
| `PRIMARY KEY (id)` | `PRIMARY KEY (occurred_at, id)` | PostgreSQL requires the partition key in every unique constraint |
| `UNIQUE (request_id, entity_domain, entity_type, entity_id, entity_version)` | the same, plus `occurred_at` | as above |
| a write outside the covered months raises | unchanged, and now includes the current month | no DEFAULT partition, by design |
| `id` is unique across the table | not enforced by a constraint | a consequence of the partition key requirement |

The weakened guarantees are stated rather than absorbed. The once-per-version guarantee now holds
within a month, not globally, and `id` is no longer constrained unique. Both are safe for the current
code — one request writes one entry per entity version inside one transaction, and `id` is a
`randomUUID()` — but a restore from a dump that was taken out of order across months could contain
duplicates. Making `id` unique again would need a second index over the whole hot table; that cost was
not judged worth it here, and the decision is recorded in `DOMAIN.md` under open decisions.

A `DELETE` against `audit.audit_entry` continues to raise `audit entries are append-only`: the row-level
trigger is recreated on the partitioned parent, where PostgreSQL propagates it to every partition, and
it fires per row. `TRUNCATE` is refused by the statement-level trigger on the parent.

The old heap's indexes and grants went with it, so all four indexes from `0001` plus a new
`(retention_class, occurred_at)` index are recreated, and the `REVOKE UPDATE, DELETE, TRUNCATE` is
re-issued.

## Rollback

There is no down migration. This is deliberate and the reason is worth stating plainly: a down
migration for a table drop can only be a rename, and after a successful run the heap is gone, so the
rename has nothing to rename. Writing a down migration that cannot execute would be worse than not
writing one.

What the migration does guarantee is that a **failure** needs no rollback at all. The whole file runs
in one transaction (see the header), and every destructive step comes after the copy and the two
verification queries. A failure at any point leaves the legacy heap as the live table, with its
indexes, its triggers and its grants, and the partitioned copy as an unreferenced table that
`0003`'s `DROP TABLE` comment already documents how to remove.

A **successful** migration is a one-way move. Recovery is the restore procedure the repository already
rehearses: `pnpm dr:rehearse:local`, backed by point-in-time recovery. Rehearsing the swap before
production is a release prerequisite, because the copy has not been run against a production-sized
table.

If the swap must be undone deliberately after it committed, the route is: stop writes, restore the
database to a point before this migration, and re-run the ordered migration list. That is a restore,
not a rollback, and it is bounded by the archive-of-record, not by this file.
