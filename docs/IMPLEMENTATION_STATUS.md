# Implementation status — 25 September 2026

The supplied PRD is the product baseline; the implementation plan controls sequencing. This repository began empty. Work started with F0 / S1 feature `PLT-001`; a partial S2 `PLT-003` contract foundation is now present.

Product Owner clarification on 24 September 2026: `producer` is required in every event envelope. The copied PRD Appendix C wording was aligned with §72.1 PLT-000.R20; `branchId` and `actor` remain optional.

Product Owner clarification on 25 September 2026: the four current distribution centers are Cimahi, Sukabumi, Cianjur, and Subang; Cimahi is the Operations HO pilot for the trial and proof of concept. Use **Putra Sumber Sari** as the organization display name. Official branch codes and addresses, the legal form/name, and branch activation approval remain open. See `docs/source/branches-2026-09-25.md`.

| Scope | State | Evidence or gap |
|---|---|---|
| `PLT-001` workspace, strict TypeScript, version check | Implemented | `pnpm install`, lint, typecheck, build, and toolchain tests |
| Five deployable shells and `/health/live`, `/health/ready` | Implemented as process checks | All ten endpoints returned HTTP 200 locally; readiness does not yet inspect dependencies |
| Domain and package structure | Implemented as empty scaffold | 25 domains, 7 packages, generator test |
| Local PostgreSQL/PostGIS, Redis, MinIO, Keycloak | Running locally | Docker Desktop installed in the user's Applications folder. All four Compose services became healthy. PostGIS 3.5 answered a SQL query, Redis returned PONG, and MinIO and Keycloak returned HTTP 200. `pnpm dev:up` started all five app processes; all ten live/ready routes returned HTTP 200. Readiness still means process startup only, not a dependency probe. |
| CI and PR template | Files present; remote enforcement pending | No remote repository or branch protection configured |
| `PLT-003` event names and envelope | Partial | 164 Appendix C names generated; `producer` required; one event has a typed payload and runtime publication guard. No outbox or consumer integration yet. |
| `PLT-003` generated documents and check | Partial | OpenAPI for two API health endpoints, event catalog/schema JSON, PRD sync, and checked-in event/API compatibility baselines. Both built API health routes returned HTTP 200 on port 4100. Automatic main-branch diff and business endpoints are pending. |
| `PLT-007` problem response boundary | Partial | Shared RFC 9457 contract and Nest exception filter on all four backend processes. Live missing-route probes returned 404 `application/problem+json` with stable `NOT_FOUND`, Indonesian message, request ID, and no query-string echo. Unit tests cover SoD, validation field paths, unknown-error redaction, and retry flags. Business endpoint declarations, Sentry, and complete copy mapping remain pending. |
| `PLT-003` Appendix registries | Source catalog implemented; operational use pending | Generated queryable source-preserving D/F/M/N/P catalog. Unapproved ASM/KOSONG values, incomplete copy, placeholders, and composite entries are not activated as policy. |
| `PLT-002` architecture import boundaries | Partial | Static check rejects cross-domain internals, package-to-domain imports, BFF database imports, and integration connector imports into business domains; fixture tests pass. DB and UI rules remain pending. |
| `PLT-002` SQL migration gate | Partial | Rejects unplanned destructive SQL, wrong schema ownership, unqualified tables, and cross-schema FKs; fixtures pass. No real migrations exist yet, so DB runtime behavior is unverified. |
| `PLT-002` code quality gate | Partial | Rejects hard-coded principal/branch comparisons, unstructured console logging, and untracked TODOs; fixture tests pass. It does not yet prove every command is authorized, audited, or event-safe. |
| `UX-001` design tokens and `ui:check` | Partial | Shared CSS and TypeScript tokens power the web shell. The UI gate checks hard-coded hex outside tokens and selected English button labels. Components, page templates, accessibility and visual checks remain pending. |
| Development feature directory `/fitur` | Implemented as a read-only roadmap view | Generated from the 280 matching PRD specifications and implementation plan rows; search and filters show phase, sprint, purpose, and verified status. Only PLT-001 links to an existing screen. Production builds hide the internal directory. It is not an operational ERP surface. |
| Integration/e2e | Scaffold only | These gates do not yet exercise business workflows or persistence. |
| ADR-0001 through ADR-0011 | Register available in PRD; full records pending | Register summaries are not enough to create justified decisions; several Sprint 0 OD remain open |
| Operational ERP, Finance, integrations, role experiences | Planned | Depend on F0 controls, business decisions, and phase gates |

## Next scheduled work

Sprint 0 still requires owner assignments, cloud/IaC/observability/IdP decisions, example ND6/FoxPro and finance data requests, and official master-data fields. Pilot branch selection is resolved. Continue S2 with runtime registry decisions, request validation and problem responses, a true main-branch OpenAPI diff, more versioned event payloads, and `UX-001` components/templates in the plan's dependency order. The full ERP remains a 280-feature roadmap with business data and phase gates; the current checkout is a runnable foundation, not a transaction-ready ERP.
