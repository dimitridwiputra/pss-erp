# Audit domain

Status: AUD-001 transactional write foundation, OD-19 retention, and the monthly-partition swap implemented; read/export and integrity controls remain planned.

## Purpose

Keep an immutable record of who changed an operational fact, when, why, and through which request. The owning domain supplies the material change and uses the same PostgreSQL transaction for its mutation, outbox insert, and audit entry. Past its hot window an entry moves to cold archive storage, and the partition that held it is released from the primary database.

## Owns

`AuditEntry` and the `audit.audit_entry` table, its monthly partitions, and the retention policy that decides when a partition may be released. It does not own the underlying business fact.

## Does not own

Operational state, technical HTTP logs, authentication, permission decisions, event delivery, or the archive bytes themselves. The cold archive is an injectable `AuditArchive`; the domain owns the decision, not the storage.

## Commands

`withAuditedTransaction(pool, work)` opens one database transaction. The callback uses `client` for the business mutation and `appendAuditEntry(input)` for the audit record. It cannot commit without at least one audit entry. A failed insert rolls the whole transaction back. Callers must perform authorization before entering the callback and pass the actual actor, entity version, and material before/after values.

`runAuditedWork(client, work)` applies the same audit requirement inside an already-open command transaction. The application composes it with Platform idempotency so the key, business effect, audit, and outbox can share one commit without Platform importing Audit.

`archiveExpiredAuditPartitions(pool, input)` (OD-19) is the retention run. It walks the partitions whose month has closed, counts the rows in each that are still inside their class's hot window, pages the survivors to an `AuditArchive`, and drops a partition only when every page came back confirmed and the row count has not moved. It uses `withAuditedTransaction`, not `runCommand`: `@pss/platform` depends on `@pss/audit`, so this domain cannot import the platform pipeline without a package cycle, and the audited primitives `withConnection` delegates to are the ones defined here. Idempotency is a property of the algorithm rather than a record — a re-run finds nothing to release, and a retried page writes the same archive object because its cursor is derived from the partition and the page's first row.

`ensureAuditPartitions(pool, input)` creates the missing monthly partitions for a forward horizon. It exists because the table has no DEFAULT partition by design, so a write into an uncovered month raises. It is audited, including a run that created nothing, because a partition set that is silently not advancing is the failure it prevents.

## Queries

No public query yet. The indexed table can be queried by entity, correlation, actor, or time for internal investigations. A scoped, audited read/export API awaits RBAC-002. Note that a query for a row by `id` is no longer covered by a unique constraint, and the once-per-version guarantee is per-month; see Tables.

## Events produced and consumed

None. Audit is a transactional record, not a domain event. DWH-003 stream is pending.

## Tables

`audit.audit_entry` is `PARTITION BY RANGE (occurred_at)`, one partition per month, named `audit_entry_YYYY_MM`, promoted from the prepared copy by `0006_audit_entry_partition_swap.sql`. UUID IDs, UTC timestamp, actor/service/delegation, entity and version, field changes, reason, request/correlation/causation, source, and `retention_class` are explicit columns. An actor and a change are required. UPDATE, DELETE, and TRUNCATE are rejected by triggers on the partitioned parent.

`retention_class` is `FINANCIAL | BUSINESS | SECURITY | RAW_LANDING`, defaulting to `BUSINESS`. SEC-001 classification `INTERNAL`. It exists so a period can be changed by writing configuration rather than by a migration; the period itself is never stored on a row.

`audit.ensure_month_partitions(regclass, date, date)` creates the missing months between two bounds and returns how many it created. `audit.drop_month_partition(text)` removes one partition and refuses any name that is not a monthly partition of `audit.audit_entry`. Both are in migration `0005_audit_partition_management.sql`.

## Invariants

- An audit entry is committed with its owning mutation or neither is committed.
- A state transaction using this wrapper needs at least one audit entry.
- Personal and sensitive fields, common credential paths, bearer values, and long numbers embedded in text are redacted before insert.
- Stored audit entries cannot be changed through normal SQL mutations.
- A partition is never dropped while any row in it is still inside its class's hot window, whatever the archive reports.
- A partition is never dropped until every page of it was archived and every receipt matched on partition, cursor, row count, and content digest.
- A month that has not closed is never a candidate, whether or not it is empty.
- The row count is re-read immediately before a drop, so a row that appeared after the archive stops the drop.
- The retention run cannot reach its own audit entries: they are written at `now()`, and only closed months are candidates.

## Dependencies

PostgreSQL and `pg`. The wrapper uses one `pg` client for the full transaction, as required by node-postgres transaction semantics. Zod validates input before insertion. No cross-domain database read is performed.

## Open decisions and limits

- **OD-19 is answered for the hot/total split only.** 24 months hot, 10 years total, was accepted; the per-class periods were left blank in the decision and the proposal's 10y/7y/3y/180d was not confirmed. The default therefore applies 24/10 to every class rather than inventing four numbers, and `classPeriods` is where the later decision lands as a configuration write. The class vocabulary itself comes from that proposal and has not been separately confirmed.
- **The retention policy is a domain object, not a `platform.config_value` key.** `proposeConfigValue` refuses a key outside the generated registry, and registering `audit.retention.*` means editing `docs/PRODUCT_PRD.md` and regenerating `packages/contracts`, neither of which is the audit domain's to change. Until that is done, the policy is passed to the run by its caller. This is the one place where "configuration, not schema" is not yet literally true end to end.
- **The swap weakened two database-level guarantees.** A unique constraint on a partitioned table must include the partition key, so `PRIMARY KEY` is `(occurred_at, id)` and the once-per-version constraint is per-month rather than global, and `id` is no longer constrained unique across the table. Both are safe for the current code and are recorded in `0006_audit_entry_partition_swap.migration-plan.md`; restoring `id` uniqueness would need a second index over the whole hot table.
- **The cold archive is an interface, not an implementation.** `AuditArchive` has no S3 or GCS client behind it, so the retention rule is testable without cloud credentials and no restore path has been exercised. A restore rehearsal is a production prerequisite; the interface was shaped so that supplying a real client does not change this file.
- **Storage monitoring at 80% of provisioned capacity is not implemented.** With a partitioned table the cost is bounded only if someone notices growth. The retention run reports `partitionsNotYetClosed` and dropped/held counts in its audit entry, which is the raw material for such an alert.
- **The retention run writes one audit entry per run and per released partition, all at the default class.** An operator asking why a partition is still there gets `ROWS_INSIDE_HOT_PERIOD` or a receipt reason in the trail rather than silence.
- **AUD-001 remains partial:** there is no RBAC-protected read/export UI or API, audit-of-read, hash chain, DWH stream, or one-year search performance evidence.
- **Reason code obligation** depends on approved STM transitions and must be enforced by each owning command until a registry-backed guard exists.
- **Production database privileges and tamper evidence need Security review.** A PostgreSQL superuser or table owner with DDL privileges can still disable the append-only triggers. `audit.drop_month_partition` narrows this to a named function but does not eliminate it.
- **Partition bounds follow the server's time zone.** The bounds are built from a `date`, so they land on midnight of a calendar month in the session zone. The retention cutoff is month-aligned too, so the two agree, but a server whose zone changes reinterprets the edges. The test fixtures pin the bounds to UTC.

## Acceptance tests

`tests/audit-rules.test.ts` verifies input rejection and redaction. `tests/audit-transaction.integration.test.ts` creates an isolated PostgreSQL database, applies the migration, verifies atomic commit and rollback, redaction, delegation, uniqueness, and DB immutability, then drops that temporary database. `tests/partition-swap.integration.test.ts` applies every migration except the swap to a database that already holds rows, then runs the swap and verifies that every row and its retention class survived, that the months the rows span were partitioned, and that the post-swap write path still works. `tests/audit-retention.integration.test.ts` covers the policy, the drop rule, the archive-and-drop run against a real partitioned table, and the drop function's own refusals; every guard in the drop rule was verified by removing it and confirming the corresponding test fails.
