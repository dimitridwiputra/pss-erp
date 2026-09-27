# Sprint 3–5 development evidence — 27 September 2026

**Gate state: open.** The implementation plan schedules Sprint 3 for 2–13 November, Sprint 4 for 16–27 November, and Sprint 5 for 30 November–11 December 2026. Work below is early local development, not a claim that those scheduled sprints have passed Definition of Done. The Sprint 0–2 gate is also open in [S0-S2-evidence.md](S0-S2-evidence.md).

## What is implemented and verified locally

| Feature | Verified slice | Remaining Definition of Done |
|---|---|---|
| AUD-001 (S3) | Append-only audit migration, redacted entry, shared mutation transaction, and PostgreSQL rollback/immutability tests. | Production command adoption, scoped search/export, retention/tamper evidence, and fitness gate. |
| IDN-001 (S3) | `jose` JWKS verifier checks RS256 signature, issuer, audience, expiry, subject, and issued-at claims. Identity migration enforces a unique IdP subject; protected `/me` resolves current active PSS account. HTTP/PostgreSQL tests show inactive accounts and old tokens are denied on the next request. | Configured local/hosted Keycloak realm, web authorization code + PKCE, refresh/logout, session revocation, mobile offline age, all-deployable JWKS checks, and three-environment IaC. |
| PLT-004 (S3) | PostgreSQL outbox, same-client insert, ordered polling dispatcher, retry, and at-least-once duplicate test. | BullMQ fan-out, live consumer registry, archive/replay, lag/throughput evidence. |
| PLT-006 (S3) | Command key scope/hash, response replay, seven-day retention, audit-composed transaction, and concurrent PostgreSQL tests. | API interceptor, required-key endpoint gate, cleanup job, metrics. |
| PLT-007 (S3) | RFC 9457 response schema/filter and live Nest error tests. | Full business error mapping and complete user copy. |
| PLT-005 (S4) | `withInbox` uses a consumer-owned `inbox_event` table and one PostgreSQL transaction for receipt and effect. Five simultaneous copies produce one effect; a crashed handler leaves neither receipt nor effect and can retry. | Real consumer migration/worker, retry/backoff, out-of-order delay, DLQ and audited replay, retention/metrics/alerts, inbox fitness gate. |
| PLT-012 (S5) | `pnpm dr:rehearse:local` creates isolated source and restore databases, applies current migrations, streams a PostgreSQL dump/restore, compares synthetic identity/audit/outbox records, and removes both databases. A CI job is declared for the same rehearsal. | Hosted CI run, managed PITR, retention, storage object lock/separate account, finance invariants, scheduled restore/alerts, production two-person approval, and DR timing evidence. |

`GET /me` is a protected API capability, not web login. It has no role or permission output and cannot authorize a business operation. The local Keycloak container currently has no PSS realm or user seed. An isolated JWKS server in tests proves the HTTP boundary without representing a production IdP. The inbox test uses a consumer-owned `reporting` fixture schema; there is no registered reporting worker or production inbox table yet.

## Feature inventory still required by the implementation plan

| Sprint | Planned features that remain unimplemented or have only the partial slices above |
|---|---|
| S3 | AUD-001, IDN-001, PLT-004, PLT-006, PLT-007 (partial); RBAC-001, RBAC-002, SEC-001, UX-002 (planned) |
| S4 | PLT-005 (partial); APR-001, DQ-001, IDN-002, IDN-003, IDN-004, MED-001, PLT-008, PLT-009 (planned) |
| S5 | PLT-012 (partial); APR-002, DOC-001, DOC-002, NTF-001, OBS-002, PLT-010, RBAC-003, UX-003, MDM-001, INT-005, ADM-008 (planned) |

The S4 walking skeleton still has no audited command → outbox → queue → inbox → read model → BFF path. The S5 F0 gate cannot close without that path, end-to-end approval and login/MFA, three IaC environments, and a recorded restore exercise. OD-119, OD-120, OD-185, OD-187, OD-188, official business owners, and hosted CI/branch protection remain unresolved in the source documents or external environment. Missing facts remain unset rather than seeded as operational truth.

## Local verification

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm ui:check
pnpm features:check
pnpm test
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm test:integration
pnpm build
pnpm dr:rehearse:local
```

The PostgreSQL URL is only for the local Compose development service. `pnpm test:e2e` is still a scaffold and does not certify a login or business workflow.
