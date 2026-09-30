# Runbook: audit archive and restore

**Owner:** audit domain (`domains/audit`)
**Applies to:** `audit.audit_entry` partitions that have passed their retention hot window
**Requirement:** OD-19, PRD §70 (Audit & Reconciliation), §87 (Backup & DR)
**ADR:** `docs/adr/ADR-0014-audit-once-per-version-invariant.md`

## What this is for

`audit.audit_entry` is append-only. `UPDATE` and `DELETE` are refused by trigger (`0004`), so a
PostgreSQL `DROP TABLE` on a partition is the **only** way a row leaves the hot database. That makes
the archive the only other copy, and it makes two things true that this runbook exists to keep true:

1. A partition may only be dropped after its archive has been **restored and read back**.
2. Nobody needs to restore an archive under pressure without having rehearsed it.

## The retention rule in one table

Two settings, and they answer different questions. Conflating them is how evidence gets destroyed by
accident, so they are stored in separate columns.

| Setting | Question it answers | Stored where | `KOSONG` means |
|---|---|---|---|
| `audit.hot_months` | How long is a row queryable in the primary database? | `audit.audit_partition_state` period bounds | not applicable — a required value |
| `audit.retention_years` | How long is the archived **object** kept? | `audit.audit_archive_object.retention_mode` | `INDEFINITE` — never deleted |

**A partition can be dropped from the hot database while its archive is retained forever.** That is
intended, not a bug. Hot residency and archive destruction are independent decisions.

Default policy today: `audit.retention_years = 10`, `audit.hot_months` 24 months for `FINANCIAL`,
6 months for `OPERATIONAL`, 3 months for `SECURITY`.

## The partition lifecycle

```
HOT ──▶ ARCHIVING ──▶ ARCHIVED ──▶ ARCHIVED_VERIFIED ──▶ HOT_PARTITION_DROPPED
                                                    │
                                                    └── HELD (with a reason, and the partition intact)
```

`ARCHIVED` and `ARCHIVED_VERIFIED` are separate states on purpose. "The bytes were written" and "the
bytes came back and matched" are different facts, and only the second one justifies deleting the
other copy.

The terminal state `HOT_PARTITION_DROPPED` is reachable **only** from `ARCHIVED_VERIFIED`, which
requires a `VERIFIED` row in `audit.audit_restore_verification`. The database enforces this with a
CHECK constraint, not with application logic alone.

## Before you run rotation in production

**Do not enable the archive-and-drop scheduler until the restore drill below has been completed
successfully against the production archive target, on real data, at least once.**

The currently registered client is `FileAuditArchive`, which writes to a local directory. A local
directory is **not** independent of the host: if the database host is lost, the archive is lost with
it, and the archive is worse than useless because the partition has already been dropped. A real
object-store client (S3-compatible, versioned, object-lock capable) is required before production
rotation. Until then the scheduler stays disabled — see "Residual risk" below.

## Restore drill

This is the procedure. Run it before trusting the archive, and again whenever the storage client,
the schema, or the archive format changes.

### 1. Choose a partition to restore

Pick one that has already been dropped, so the only copy is the archive. Reading the receipt:

```sql
SELECT o.source_partition,
       o.period_from,
       o.period_through,
       o.object_uri,
       o.row_count,
       o.min_occurred_at,
       o.max_occurred_at,
       o.checksum_sha256,
       o.schema_version,
       o.retention_mode,
       o.purge_after,
       o.status,
       v.status        AS restore_verification,
       v.verified_at,
       v.scratch_database
  FROM audit.audit_archive_object o
  LEFT JOIN audit.audit_restore_verification v ON v.archive_object_id = o.id
 ORDER BY o.created_at DESC
 LIMIT 20;
```

Record the `object_uri` and `checksum_sha256`. Every subsequent step compares against them.

### 2. Retrieve the object

Copy the object to the host that will run the restore, keeping the sidecar manifest
(`.manifest`) with it. Verify the bytes before reading them:

```bash
sha256sum <object>   # compare against the manifest's contentSha256
cat <object>.manifest
```

If `contentSha256` does not match, **stop**. The object is damaged; a restore will not fix it.

### 3. Restore into an isolated database

Never into the operational database. A restore that touches `audit.audit_entry` directly would
mutate an append-only table and could attach rows to the wrong partition.

```bash
createdb pss_audit_restore_probe
psql -d pss_audit_restore_probe -f domains/audit/infrastructure/database/migrations/0001_audit_entry.sql
# ... and every later audit migration, in order. The whole ordered list, not a hand-picked pair:
# restoring into a partial schema proves nothing about a real one.
```

Then create a monthly partition for **every month the artifact covers**, before loading rows:

```sql
CREATE TABLE audit.audit_entry_2021_12 PARTITION OF audit.audit_entry
  FOR VALUES FROM ('2021-12-01 00:00:00+00') TO ('2022-01-01 00:00:00+00');
```

> **Why this step exists.** A freshly migrated schema only creates partitions for the current and
> forthcoming months. Loading an archive from a past month into it fails with
> `no partition of relation "audit_entry" found for row`. This was found by the round-trip test in
> `domains/audit/tests/audit-archive-restore.integration.test.ts`, not by a dry run.

### 4. Load and validate

```sql
\copy audit_restored FROM 'restored.ndjson' WITH (FORMAT csv, HEADER true)
```

Then check all four, against the values from step 1:

| Check | Expected | Why it exists |
|---|---|---|
| `count(*)` | `row_count` | catches truncation, the classic archive failure |
| digest over the row digest | `checksum_sha256` | catches a row that restored with a null actor, a coerced timestamp or a reordered `changes` payload — same count, different record |
| `min(occurred_at)` / `max(occurred_at)` | the recorded bounds | catches a partial load that a count alone would miss |
| a lookup by `entity_id` + `request_id` | at least one row | catches an archive that loaded but cannot be queried the way an auditor would |

```sql
SELECT count(*) FROM audit_restored;
SELECT * FROM audit_restored
 WHERE entity_id = '<a real id from the artifact>'
   AND request_id = '<its request_id>';
```

### 5. Record the outcome

The `audit_restore_verification` row is the evidence a drop depends on, and it is written by the
retention run, not by hand. A manual drill is not a substitute for it: a hand-written `VERIFIED` row
would let a partition be dropped on the strength of a note.

### 6. Destroy the scratch database

```bash
dropdb pss_audit_restore_probe
```

Every run drops its own scratch database automatically. A leftover one is an unmanaged second copy of
aged audit rows — a disclosure surface, not a control.

## When something goes wrong

| Symptom | Meaning | Action |
|---|---|---|
| `HELD` with `ARCHIVE_RECEIPT_MISMATCH` | The archive succeeded but the restore did not verify | **Nothing was deleted.** Read `audit.audit_restore_verification.failure_reason`. Do not retry the drop until it passes. |
| `HELD` / `ROWS_INSIDE_HOT_PERIOD` | The partition still holds a row inside **its own class's** hot window | Working as intended. The partition is not a candidate, and nothing is copied. |
| `HELD` / `ARCHIVE_NOT_ATTEMPTED` | A page of the partition was never confirmed by the archive | Working as intended. A partial archive is worse than none. Re-run to retry. |
| `HELD` / `ARCHIVE_RECEIPT_MISMATCH` | The archive succeeded but the restore did not verify, **or** the row count changed between counting and archiving, **or** no page reported an object URI | **Nothing was deleted.** Read `audit.audit_restore_verification.failure_reason`. Do not retry the drop until it passes. |
| Verification `FAILED`, `digest does not match` | The stored bytes are not the bytes that were archived | **Stop.** Treat as evidence corruption. The partition is still intact — that is the gate working. |
| Verification `FAILED`, `digest differs` (after load) | The rows loaded but a field did not round-trip | Same count, different record. Partition intact. |
| Verification `FAILED`, `could not be found by entity_id` | It loaded but is not queryable | The archive is not usable evidence. Partition intact. |

Those three are the complete set of hold reasons; a `HELD` outcome with any other reason is a bug.

A month that **has not closed** produces no outcome row at all — only the run's
`partitionsNotYetClosed` counter. Two reasons, both load-bearing: rows can still arrive into an open
month, and an empty month still has to exist for the writes that are coming. A run that released every
empty partition would delete the months `ensureAuditPartitions` provisioned and turn the next write
into `no partition of relation found for row`.

**No failure mode in this table deletes a partition.** A partition is dropped only after a `VERIFIED`
restore, and every other outcome leaves it in place with a recorded reason.

## Residual risk, stated plainly

- **No database roles exist.** `audit.drop_month_partition` is not restricted to a maintenance role,
  because this repository's migrations create no roles at all. An application connection that can
  `DROP TABLE` can drop a partition without going through the gate. Closing this needs role
  separation, tracked as its own deliverable (RBAC / PLT-001) rather than bolted on here.
- **The registered archive client is a local directory.** See "Before you run rotation in production".
- **The database provides no once-per-version protection after the partition swap.** The partitioned
  `UNIQUE (occurred_at, request_id, ...)` constraint is inert, because `occurred_at` defaults to
  `now()` at microsecond precision and so never collides. Transactional coupling plus the optimistic
  version is the only guarantee. See ADR-0014 (`AUD-RISK-001`) and its five revisit triggers.
- **Hash chaining is not implemented.** `audit_archive_object.hash_chain_*` are nullable columns,
  because recording a chain that does not exist would be a fiction.

## Related

- `domains/audit/tests/audit-archive-restore.integration.test.ts` — AUD-ARCHIVE-03/05/07
- `domains/audit/tests/audit-retention.integration.test.ts` — AUD-ARCHIVE-01/02
- `domains/audit/tests/audit-once-per-version.integration.test.ts` — the inert-constraint finding
- `docs/runbooks/outbox-stall.md`
