# Sprint 3–5 development evidence — 27 September 2026

**Gate state: open for production release; local implementation gate is green for the delivered slices.** The implementation plan schedules Sprint 3 for 2–13 November, Sprint 4 for 16–27 November, and Sprint 5 for 30 November–11 December 2026. This record separates code that is verified locally from Definition of Done evidence that requires business owners, hosted CI, staging, or production controls.

## Delivered and verified locally

| Planned slice | Evidence | Remaining release evidence |
|---|---|---|
| AUD-001 | Append-only audit migration, audited mutation transaction, redaction, rollback and PostgreSQL immutability tests. Approval, session-revocation, and operational handover mutations use audit composition. | Production retention/tamper controls, scoped search/export, and full command-fitness adoption. |
| IDN-001 / IDN-002 | Local Keycloak OIDC with JWKS/issuer/audience/expiry verification, Auth.js encrypted HttpOnly session, AMR mapper, recent-MFA step-up policy, inactive-account denial, and database-backed session revocation. Nine API integration tests pass. | Hosted IdP, IdP-wide logout, mobile offline-age policy, rotation/refresh expiry evidence, and multi-environment IaC. |
| RBAC-001/002 / RBAC-003 | Default-deny permission × scope checks are server-side. Approval inbox filters through permission and scope checks; admin session revocation requires `identity.session.revoke`, organization scope, and recent MFA. | Complete role-management UI, permission assignment commands, and full Appendix D matrix sign-off. |
| APR-001 / APR-002 | Effective-dated approval types, policy levels, threshold selection, delegation, SoD, concurrency locking, audit, `APPROVAL_REQUESTED`/`APPROVAL_DECIDED`, protected inbox and decision API. API and domain tests pass. | Business owner policy seeds and a browser approval demo with a real staged account. |
| PLT-004 / PLT-005 | Fulfillment delivery confirmation writes a canonical event to the transactional outbox. BullMQ dispatches it to a reporting consumer with consumer-owned inbox dedupe and a read model. Approval events use the same pipeline. The live Postgres/Redis event-pipeline integration test passes, including replay. | DLQ/replay console, retention/lag metrics, alerts, and hosted worker deployment. |
| PLT-006 / PLT-007 | Idempotency, RFC 9457 problem responses, request validation, and safe error logging remain green in unit and integration tests. | Interceptor coverage on every mutating endpoint, cleanup/metrics, and complete business copy registry. |
| PLT-009 | `@pss/configuration` now validates generated registry keys, resolves effective-dated values by business date and deterministic scope, preserves `UNSET`, and has a Postgres `platform.config_value` migration. | Owner approval workflow/API and gate reports for ASM/KOSONG values. |
| PLT-010 | `@pss/configuration` provides an OpenFeature server provider backed by PSS flag rows, with org/branch/role/user targeting and fail-closed defaults. `platform.feature_flag` migration is included. | Admin console, audited flag mutations, client snapshot/BFF endpoint, expiry report, and staged rollout evidence. |
| PLT-012 / UX-003 | Local restore rehearsal, standard Indonesian loading/empty/error/offline/sync states, and shared component accessibility tests pass. | Managed PITR, retention/object-lock evidence, production restore timing, and adoption across every product surface. |

## Repository verification on 27 September 2026

The following commands pass in this checkout:

```bash
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm ui:check
pnpm features:check
pnpm test                 # 69 tests on 29 September
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' \
  REDIS_URL='redis://127.0.0.1:6379' pnpm test:integration  # 109 tests
pnpm build
```

The web production build includes `/masuk`, `/beranda`, `/persetujuan`, `/kasir`, `/gudang`, and `/fitur`. `pnpm test:e2e` is a real gate: it starts `next dev` and runs three Playwright specs (POS preview happy and exception paths, PSS Kasir offline banner), and it can fail CI. The Keycloak browser login suite must be run separately with `pnpm test:e2e:local` while `pnpm dev:up` is running. Browser sign-in, approval inbox, order, and WMS critical paths are still uncovered by the CI gate. POS and WMS domain and UI code is under development. `PosController` is intentionally not registered in the API module until every route has server-side permission, scope, state, and idempotency checks, including cash handover; a live probe returns 404 for `POST /pos/shifts/:id/cash-handover`. `WmsController`, however, **is** registered and is in the `architecture:check` allow-list, which earlier evidence here mis-reported as returning 404. Its 21 mutating routes each read the caller from the Authorization header, require an `Idempotency-Key`, validate body, path and query input with `ZodValidationPipe`, and derive warehouse scope from a canonical record lookup rather than a caller-supplied id. `POST /users/:id/revoke-sessions` remains a registered mutating route with no idempotency key, and `revokeUserSessions` is not replay-safe: a retry bumps `identity.user_account.version` again and appends a second audit entry.

## Definition-of-Done limits still open

- Production F0 is not closed: official branch/master-data approval, named owners, hosted CI and branch protection, three deployable environments, managed observability, and managed backup/restore are external evidence.
- System Console (ADM-008), document numbering/rendering, media, notifications, exception queue UI, and complete user/device management are not yet delivered as user-facing workflows.
- Configuration and flags have the typed/runtime foundation and tables, but not their admin write API and audited console.
- Missing business values remain `UNSET` or safe-off by design; no branch codes, addresses, legal form, or operational finance assumptions were invented.
