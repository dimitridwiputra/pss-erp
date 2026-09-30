# Runbooks

## Local audit and outbox database

`pnpm dev:up` brings up the local containers and runs `pnpm db:migrate`, which applies every domain's pending migrations (`scripts/migrate-local.mjs`) before starting the app shells. The domains and their migration files are both read from disk. `public.pss_schema_migration` records what has run, so a re-run applies only new files. A shipped migration whose content changed is reported, not re-run. To apply them to the local development database without starting anything:

```bash
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm db:migrate
```

A database created before the ledger existed is bootstrapped once. Each file runs in a savepoint, and one whose effect is already present is recorded as already applied, with a warning naming it.

The database integration test uses a temporary database and removes it after the test. Run it after starting PostgreSQL:

```bash
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm test:integration
```

Operational runbooks will be added with the owning feature. The implementation plan Appendix D holds the initial go-live and cutover checklist.

## Local restore rehearsal (PLT-012 foundation)

Run `pnpm dr:rehearse:local` with Docker Desktop running. The script creates two temporary PostgreSQL databases, applies current audit/platform/identity migrations to the source, inserts synthetic records, streams a PostgreSQL dump into the restored database, compares counts and identifiers, and drops both temporary databases. It does not touch the development database's records and does not create a backup file. This proves only that current local schemas and synthetic records can be restored; PITR, finance invariants, managed backup retention, separate-account storage, and production two-person approval remain open under OD-188/OD-40.
