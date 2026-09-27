# Runbooks

## Local audit and outbox database

`pnpm dev:up` brings up the local PostgreSQL container and applies `AUD-001` migration 0001, `PLT-004`/`PLT-006` platform migrations 0001–0002, and the IDN-001 account migration before starting app shells. These are safe to rerun. To apply them separately to the local development database:

```bash
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/audit db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/platform db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/identity db:migrate
```

The database integration test uses a temporary database and removes it after the test. Run it after starting PostgreSQL:

```bash
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm test:integration
```

Operational runbooks will be added with the owning feature. The implementation plan Appendix D holds the initial go-live and cutover checklist.

## Local restore rehearsal (PLT-012 foundation)

Run `pnpm dr:rehearse:local` with Docker Desktop running. The script creates two temporary PostgreSQL databases, applies current audit/platform/identity migrations to the source, inserts synthetic records, streams a PostgreSQL dump into the restored database, compares counts and identifiers, and drops both temporary databases. It does not touch the development database's records and does not create a backup file. This proves only that current local schemas and synthetic records can be restored; PITR, finance invariants, managed backup retention, separate-account storage, and production two-person approval remain open under OD-188/OD-40.
