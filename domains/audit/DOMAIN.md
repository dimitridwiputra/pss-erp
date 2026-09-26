# Audit domain

Status: AUD-001 transactional write foundation implemented; read/export and integrity controls remain planned.

## Purpose

Keep an immutable record of who changed an operational fact, when, why, and through which request. The owning domain supplies the material change and uses the same PostgreSQL transaction for its mutation, outbox insert, and audit entry.

## Owns

`AuditEntry` and the `audit.audit_entry` table. It does not own the underlying business fact.

## Does not own

Operational state, technical HTTP logs, authentication, permission decisions, or event delivery.

## Commands

`withAuditedTransaction(pool, work)` opens one database transaction. The callback uses `client` for the business mutation and `appendAuditEntry(input)` for the audit record. It cannot commit without at least one audit entry. A failed insert rolls the whole transaction back. Callers must perform authorization before entering the callback and pass the actual actor, entity version, and material before/after values.

`runAuditedWork(client, work)` applies the same audit requirement inside an already-open command transaction. Platform uses it for idempotent commands so the key, business effect, audit, and outbox can share one commit.

## Queries

No public query yet. The indexed table can be queried by entity, correlation, actor, or time for internal investigations. A scoped, audited read/export API awaits RBAC-002.

## Events produced and consumed

None. Audit is a transactional record, not a domain event. DWH-003 stream is pending.

## Tables

`audit.audit_entry` via `infrastructure/database/migrations/0001_audit_entry.sql`. UUID IDs, UTC timestamp, actor/service/delegation, entity and version, field changes, reason, request/correlation/causation, and source are explicit columns. An actor and a change are required. `(request_id, entity_domain, entity_type, entity_id, entity_version)` is unique. UPDATE, DELETE, and TRUNCATE are rejected by triggers.

## Invariants

- An audit entry is committed with its owning mutation or neither is committed.
- A state transaction using this wrapper needs at least one audit entry.
- Personal and sensitive fields, common credential paths, bearer values, and long numbers embedded in text are redacted before insert.
- Stored audit entries cannot be changed through normal SQL mutations.
- No retention purge runs while OD-40 remains open.

## Dependencies

PostgreSQL and `pg`. The wrapper uses one `pg` client for the full transaction, as required by node-postgres transaction semantics. Zod validates input before insertion. No cross-domain database read is performed.

## Open decisions and limits

- AUD-001 remains partial: there is no RBAC-protected read/export UI or API, audit-of-read, hash chain, monthly partition/archive, DWH stream, one-year search performance evidence, or command-handler fitness check.
- Reason code obligation depends on approved STM transitions and must be enforced by each owning command until a registry-backed guard exists.
- Production database privileges and tamper evidence need Security review. The table triggers prevent normal UPDATE/DELETE/TRUNCATE; a PostgreSQL superuser or table owner with DDL privileges can still disable them.
- OD-40 retention stays unset; entries are not purged.

## Acceptance tests

`tests/audit-rules.test.ts` verifies input rejection and redaction. `tests/database-check.test.ts` keeps the migration gate from treating a permission REVOKE as destructive. `tests/audit-transaction.integration.test.ts` creates an isolated PostgreSQL database, applies the migration, verifies atomic commit and rollback, redaction, delegation, uniqueness, and DB immutability, then drops that temporary database.
