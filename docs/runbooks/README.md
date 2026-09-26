# Runbooks

## Local audit and outbox database

`pnpm dev:up` brings up the local PostgreSQL container and applies `AUD-001` migration 0001 plus `PLT-004`/`PLT-006` platform migrations 0001–0002 before starting app shells. These are safe to rerun. To apply them separately to the local development database:

```bash
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/audit db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/platform db:migrate
```

The database integration test uses a temporary database and removes it after the test. Run it after starting PostgreSQL:

```bash
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm test:integration
```

Operational runbooks will be added with the owning feature. The implementation plan Appendix D holds the initial go-live and cutover checklist.
