# PSS Operating Platform — progress review and next development plan

**As of:** 27 September 2026 (Asia/Jakarta)

**Basis:** `docs/PRODUCT_PRD.md` (behavior and Appendix L), `docs/IMPLEMENTATION_PLAN.md` (dependencies and baseline schedule), `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`, and the current checkout.

**Purpose:** execution addendum. It does not change the PRD, feature dependencies, phase gates, or approved milestone dates.

## 1. Progress, with the right meaning

The generated directory covers all **280** PRD features. Its current labels are **1 available, 9 partial, 270 planned**. For F0 alone, the labels are **1 available, 9 partial, 24 planned** across 34 features. “Available” means the PLT-001 foundation page can be opened; it does **not** certify that every PLT-001 acceptance criterion or the F0 release gate has passed. This is a feature-status count, not a percentage of engineering effort or business readiness.

| Area | Evidence in checkout | What remains before the PRD outcome |
|---|---|---|
| Workspace and local stack | Five app shells, local Compose services, health routes, CI file, generator, and `/fitur` directory | Fresh-clone and five Docker image proof; hosted CI and branch protection; readiness dependency probes |
| Contracts and UI | 164 event names, one publishable payload schema, health OpenAPI, source-preserving registries, shared UI components/templates and Storybook | Typed business API/event contracts, complete runtime status/i18n mapping, visual regression and actual role workflows |
| Audit, outbox, idempotency | Three PostgreSQL migrations and isolated tests for rollback, redaction, event order/retry, and 50 same-key concurrent requests | Authorization and real command integration; broker/consumer runtime, read/export access, retention/metrics, required-key interceptor |
| Identity and security | Local Keycloak container and shared HTTP error/log foundations | OIDC login/session, scoped RBAC, MFA, permission enforcement, privacy controls and security fitness checks |
| Operations and recovery | `pnpm dev:up` works locally; local PostgreSQL and services are healthy | IaC-created staging/production, restore exercise, alerting, on-call runbooks and gate evidence |
| Business ERP | 25 domain directories, mostly scaffolds | Canonical branch/customer/product/order/inventory/AR/payment/finance facts, integrations and user workflows |

The current checkout has **no transaction-ready business ERP flow**. The development-only `/fitur` page is a roadmap view, not a collection of implemented screens. No production phase gate is ready for sign-off.

### Evidence checked for this review

- `pnpm features:check` passed and confirmed 280 matching PRD/plan rows.
- `pnpm architecture:check` passed over 79 source files, but has the alias-resolution blind spot described below.
- `pnpm test:integration` passed 15 tests in four files against isolated PostgreSQL databases. These are platform/API-boundary tests, not a business end-to-end flow.
- `http://localhost:3000/fitur` returned HTTP 200; local PostgreSQL, Redis, MinIO, and Keycloak containers were running. This is local development evidence only.
- There is no configured Git remote, hosted PR check result, branch protection, `docs/releases/F0.md`, or actual business e2e suite. The `test:e2e` command is still a scaffold.

## 2. Important findings to address first

1. **Architecture gate misses a real dependency.** `domains/platform/src/application/idempotency.ts` imports `@pss/audit`. The PLT-002 specification says Platform must not import a domain, but `scripts/check-architecture.mjs` resolves relative imports only. Move orchestration to an appropriate application boundary or inject the audit capability through a public interface, then make the check resolve workspace aliases and fail on a fixture reproducing this case. A green architecture command currently does not prove this rule.
2. **Foundations are not connected to a real command.** Audit, outbox, and idempotency work in synthetic transactions. None of the four backend shells exposes a business command. The S4 walking skeleton must prove one authorized command through mutation, audit, outbox, inbox, and BFF read model in one testable chain.
3. **PLT-001 “available” is narrower than PRD Definition of Done.** The page and workspace are usable, but evidence for fresh-clone startup, all five Docker image builds, hosted CI, and branch protection is absent. Keep the feature-directory label distinct from release certification; collect the missing evidence before closing its ticket under Appendix L.
4. **Event delivery is still a library, not a running service.** The outbox poller has no BullMQ adapter, consumer registry, worker scheduling, inbox, DLQ, replay, or monitoring. A database row is not yet evidence that a domain consumer receives an event.
5. **The baseline schedule assumes a staffed six-pod team and decisions.** The plan budgets 1,098 feature points and 32 two-week sprints. This repository does not establish team capacity or cloud/data access. Treat 11 December 2026 F0 and later dates as baseline targets, not a new delivery forecast; re-estimate at the plan's sprint reviews using measured velocity and unresolved decisions.

## 3. Next execution sequence

The dates below are the existing plan's windows. Work may start early, but dependencies and production gates stay in force.

| Window | Ordered development work | Exit evidence |
|---|---|---|
| **Sprint 0, 28 Sep–2 Oct** | Record owners and decisions for OD-119/120/185/187/188; establish the repository remote and protected review workflow; request ND6/FoxPro samples and Finance COA/trial-balance/bank examples. Keep unknown business fields unset. Verify a fresh clone and all five container builds for PLT-001. | Decision register and request ownership; fresh-clone log; first hosted CI result; explicit list of still-open OD. No invented branch codes, legal entity, finance accounts or principal rules. |
| **S1/S2, 5–30 Oct** | Close PLT-001 evidence; fix the Platform→Audit boundary and alias-aware PLT-002 fitness check; complete PLT-003 contracts needed for the first command; finish OBS-001 trace propagation and UX-001 visual regression; finish PLT-011 only after cloud/IaC choices are recorded. | Architecture fixture fails on alias violation; generated contracts/OpenAPI pass compatibility checks; local and hosted CI agree; staging is recreated from IaC and checked against PLT-011 ACs. |
| **S3, 2–13 Nov** | Implement IDN-001 OIDC/session, then RBAC-001 role/permission/scope registry and RBAC-002 default-deny server authorization. Wire AUD-001, PLT-004, PLT-006 and PLT-007 through one protected command; complete SEC-001 masking and UX-002 status labels. Use local Keycloak for development while staging choices settle. | Unauthorized and cross-branch requests fail at the server; maker/actor and request IDs persist; a repeated key cannot duplicate the mutation; audit and event share its commit; Indonesian error and status copy is shown. |
| **S4, 16–27 Nov** | Add PLT-005 inbox dedup, retry/DLQ/replay and the BullMQ transport; build APR-001 approval, DQ-001 exception queue, PLT-008 BFF, and PLT-009 effective-dated configuration in dependency order. Deliver the plan's **walking skeleton** using a PRD-registered event and a minimal authorized fact. | One browser/API flow creates the fact once, audits it, publishes from outbox, consumes idempotently under duplicate/replay, exposes a scoped read model, and shows an actionable exception when injected failure occurs. E2E has a real happy and exception path. |
| **S5, 30 Nov–11 Dec** | Complete remaining F0 items: MFA, user/device controls, media, document sequence/rendering, notifications, feature flags, system console, operational metrics, backup/restore, entitlement navigation, and standard UX states. Run F0 gate evidence against staging. | `docs/releases/F0.md` links full CI, OIDC+MFA demo, audit and replay tests, approval demo, three IaC environments, and restore result. F0 remains closed until the PRD §93 gate and Appendix L are satisfied. |

### First implementation tickets, in dependency order

1. **PLT-002 / AUD-001 boundary repair:** remove the Platform→Audit import and add a failing workspace-alias fixture; preserve single-transaction audit enforcement.
2. **PLT-001 completion evidence:** test a fresh checkout, build five Docker images, and make the local startup/readiness results reproducible.
3. **PLT-003 contract slice:** publish typed request/response/event schemas for the selected walking-skeleton command, with OpenAPI and compatibility fixtures. Keep all other catalog names non-publishable until their payload schemas exist.
4. **IDN-001 → RBAC-001 → RBAC-002:** authenticate a user, resolve explicit scopes, and deny protected reads/mutations by default. Add role and scope API tests before a business UI.
5. **PLT-004 / PLT-006 / AUD-001 runtime wiring:** add the required-key API boundary, broker adapter, audit metadata and metrics; prove atomic commit and repeat response through an actual command.
6. **PLT-005 → S4 walking skeleton:** dedupe and replay a consumer, then expose the scoped result through PLT-008. Add the first real e2e test and failure injection.

## 4. Decisions and data needed without blocking safe work

- **Can proceed with synthetic data:** contracts, auth, default-deny authorization, audit/outbox/inbox, framework approval, BFF, exception framework, and local tests.
- **Requires recorded engineering/management decisions before its gate:** cloud/data residency, IaC, observability provider/cost, IdP operation, RPO/RTO and backup retention (OD-119/120/185/187/188). Local Keycloak is a development service, not proof of production identity architecture.
- **Requires authoritative business inputs before activation:** official branch codes/addresses and legal entity; source-specific ND6/FoxPro access and files; COA, opening trial balance, bank formats; tax/costing/recognition decisions. Cimahi is the selected pilot, and the four distribution centers are documented, but none has an approved active master row.

After F0, follow the original sequence: **F1 canonical master and principal policy → F2 generic import/ND6/FoxPro with provenance → F3 Control Station → F4 Finance → F5 native O2C/P2P → F6 close → F7 Sales → F8 Antar → F9 Gudang → F10 optimization**. Do not treat a visual screen or a green unit test as a phase release. Recalculate dates only with actual team capacity, dependency completion, and the plan's steering process.
