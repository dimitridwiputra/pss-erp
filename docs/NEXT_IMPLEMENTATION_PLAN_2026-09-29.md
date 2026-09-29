# Next implementation plan — 29 September 2026

**Status:** F0 execution sequence prepared; production gate OPEN. This addendum does not replace `PRODUCT_PRD.md` or the baseline `IMPLEMENTATION_PLAN.md`.  
**Planning basis:** current working tree, including uncommitted POS and WMS work. The baseline sprint dates remain targets, not a forecast supported by measured capacity.

## 1. PRD reconciliation

The current PRD and plan contain **295 feature specifications**, including the 15 F11 PSS Kasir additions. `pnpm features:check` confirms their IDs and plan rows match. The 27 September progress review still describes a 280-feature baseline and is now marked superseded; `docs/IMPLEMENTATION_STATUS.md` has been updated to 295 and to the unregistered POS/WMS controllers. Those older statements must not be used as current release evidence.

The local foundation has real implementations for identity, scoped permission decisions, audit transactions, outbox/inbox delivery, approvals, configuration/flags, and several operational domains. The Sprint 3–5 evidence file records local test results, but its remaining production evidence is still open. In particular, the PRD §93 F0 gate requires OIDC plus MFA, an audited mutation, replay-safe consumer, approval, three IaC environments, and a backup/restore exercise with owner validation. A local test or visible page does not close that gate.

The working tree also contains early F9 WMS and F11 POS code. The plan explicitly notes that POS was brought forward; this does not waive its dependencies or Appendix L. WMS remains scheduled for F9 after inventory and fulfillment prerequisites and an approved opening count. Treat these slices as development work until their own PRD acceptance tests and release gates are met.

## 2. Immediate release blocker: protected operational routes

At the start of this review, `apps/api/src/main.ts` registered `PosController` and `WmsController`. Their controller methods generally authenticate with `getCurrentUser`, but no method in either controller invokes a permission × scope × state decision. `POST /pos/shifts/:id/cash-handover` does not even read the caller. Several POS commands also use raw request bodies; `readIdempotencyKey` is invoked on one route but its result is not passed to a command boundary. This conflicts with PRD RBAC-002, PLT-006, Appendix L.3–L.4, and AGENTS.md §§9, 14–15. These routes must be considered **unreleasable** in their current form.

**API exposure rule (P0):** keep POS/WMS controllers out of the deployable API until every route has server-side permission and scope checks, ownership checks on supplied IDs, canonical request validation, required idempotency behavior for retryable mutations, and negative API tests. If the controllers must stay registered for local work, use an explicit server-side disabled gate that returns a stable error for all POS/WMS routes; a hidden navigation item or client flag is insufficient. Do not activate a branch or real cash workflow during this interval. The owner is the API/Identity application boundary; `pos`, `wms`, and their owning domains retain all business rules. No migration is needed for containment.

**Exit evidence:** unauthenticated, wrong-role, wrong-branch, wrong-organization, stale-state, and replay requests fail safely; authorized requests reach the domain once; the cash-handover endpoint has the same checks. Add a fixture that prevents an unguarded operational controller from being registered again. Record the decision and the test output with the POS/WMS development evidence.

**Containment completed on 29 September:** POS/WMS controllers were removed from the deployable API module while their domain and UI work remains in the checkout. `architecture:check` now rejects any controller outside the reviewed foundation allow-list; its fixture rejects both POS and WMS registration. A live API smoke check returned 200 for `/health/live` and 404 for the POS cash-handover and WMS count routes. This completes containment only. Route-level authorization, ownership, validation, idempotency, SoD, and re-registration tests remain the next implementation work.

For that next work, Appendix D already lists POS and WMS permission groups, and POS-014 assigns cash declaration to `CSH-DECLARE`. The current runtime role mapping contains `WMS-EXEC` but does not yet grant the POS groups. Implement the reviewed permission mapping and derive each resource's organization/branch from its canonical record before enabling a route; do not rely on a branch or warehouse ID supplied by the caller.

## 3. Next coherent delivery sequence

| Order | Slice and PRD trace | Owner / files likely affected | Contract, schema, event impact | Completion evidence |
|---|---|---|---|---|
| 0 | Contain early POS/WMS API exposure (done); keep activation at the PRD's F9/F11 dependency gates | `apps/api`, API controller registration check and tests | No contract, event, or migration change. | Live API returns 404 for the unreviewed routes; `architecture:check` rejects registration. Re-enable only after per-route RBAC, scope, state, validation, idempotency, and SoD tests. |
| 1 | Make status and evidence truthful (local update done): PLT-003, Appendix L, §93 | `docs/IMPLEMENTATION_STATUS.md`, `docs/releases/*`, `docs/features/status.json` and generated catalog | Documentation/status only; no API or migration. | Counts and route availability reflect the 295-feature PRD and current checkout; `pnpm features:check` passes. |
| 2 | Finish F0 platform command controls: AUD-001, PLT-004/005/006, APR-001/002 | API boundary, `domains/platform`, `domains/audit`, reporting consumer, integration tests | Require idempotency keys for every relevant command; preserve typed event payloads; no cross-domain direct writes. Migration only if retention/replay metadata needs persisted state. | One protected command proves one mutation, audit, outbox, consumer-owned inbox/read model, replay, and an actionable failure in the same end-to-end story. |
| 3 | Deliver DQ-001 exception queue foundation, before DQ-002 UI | `domains/platform` exception module, contracts, migration, worker, tests | Add only PRD Appendix P queue codes and registered `EXCEPTION_*` event schemas. Platform stores exception lifecycle; subject domain resolves through its public command/event boundary. New `platform` tables and indexes require forward-only migration. | DQ-001.AC01–06 and NC01–03 pass, including concurrent dedupe, Friday business-day SLA, domain-owned resolution, failure retention, escalation, scope filtering, and 100k-item query evidence. |
| 4 | Complete remaining F0 P0/P1 foundations in dependency order: PLT-009/010, DOC-001, MED-001 → DOC-002, NTF-001, OBS-002, ADM-008 | Platform/application owners, then Web Experience | Versioned config/numbering/media contracts; audited admin writes; no invented business values. Migrations per owner. | Feature-specific AC/NC/TS, Indonesian four-state UI and API/e2e checks; generated contracts, registry, domain docs, and runbooks updated. |
| 5 | Close F0 production gate; then start F1/F2/F4 slices | Engineering gate owner and business owners | No new behavior in the gate ticket. | `docs/releases/F0.md` links hosted CI, environment/IdP/restore/observability proof, owner validation of OD-119/120/185/187/188, and Engineering sign-off. |

Order 0 is complete as containment; POS/WMS reactivation is a later, separate F9/F11 release ticket because their PRD dependencies are not complete. The next implementation PR should take one bounded F0 slice from orders 2–4 and prove its own acceptance criteria. F1 master data and the F2 connector framework may proceed in parallel only where their own prerequisites and owners are established. The F0 production gate cannot be closed by local code alone; its evidence and decisions are tracked in `docs/releases/F0.md`.

## 4. Decisions and dependencies to surface now

- **Engineering/management:** OD-119/120/185/187/188 for hosting, identity operation, observability, IaC, and recovery. Local Docker/Keycloak/restore evidence does not answer managed-environment requirements.
- **Operations/legal/finance:** official branch codes and addresses, legal entity, printer/document list (OD-123), finance COA and opening-balance source (OD-103/104), and authentic ND6/FoxPro samples (OD-03/04/14). Keep unknown values `UNSET` and avoid activating related workflows.
- **POS/WMS sequencing:** record the explicit early-work decision and preserve the original dependency edges. The WMS activation/opening-count decision and OD-150 remain prerequisites for a pilot; POS cash and payment routes need signed-off SoD and authorization before any business use.
- **DQ-001 calendar/queue policy:** reuse Appendix P definitions and the existing effective-dated configuration component. If a branch work calendar or escalation recipient is missing, surface it as a decision rather than defaulting a financial or operational SLA silently.

## 5. Verification commands for each implementation PR

Run from the repository root, after the relevant local services are ready:

```bash
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm ui:check
pnpm features:check
pnpm test
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' REDIS_URL='redis://127.0.0.1:6379' pnpm test:integration
pnpm build
```

Add targeted API integration tests for order 0 and DQ-001. `pnpm test:e2e` is no longer a scaffold — it runs three real Playwright specs (POS preview happy and exception paths, PSS Kasir offline banner) against `next dev`. Browser sign-in, approval inbox, order, and WMS happy and exception paths still need to be added before calling an operational workflow or the F0 gate complete; the sign-in path additionally needs an IdP that hosted CI can reach. Hosted CI, IaC, and restore evidence must be linked separately; local passing commands cannot stand in for them.

**Review performed on 29 September:** `pnpm lint`, `pnpm typecheck`, `pnpm architecture:check`, `pnpm contracts:check`, `pnpm db:check`, `pnpm ui:check`, `pnpm features:check`, `pnpm test` (69 tests), `pnpm test:integration` (109 tests), and `pnpm build` passed. `pnpm dr:rehearse:local` restored synthetic identity/audit/outbox data in isolated databases. These results do not validate hosted behavior or production readiness.

## 6. Remaining F0 implementation tickets

Each row is a separate reviewable slice. The owner is the PRD domain owner; the release gate owner is Engineering. The listed tests are the minimum evidence to add to the feature's full AC/NC/TS checklist in Appendix L. These tickets do not change the baseline dates or erase the Sprint 0 decisions.

| Ticket | Work and dependency | Main modules | Required exit evidence |
|---|---|---|---|
| F0-01 | Finish PLT-002/003/006/007 and AUD-001 command fitness before opening any new mutation route. | `apps/api`, `packages/contracts`, `domains/platform`, `domains/audit`, fitness scripts | Unprotected mutation fixture fails CI; protected command has typed request/response, required idempotency key, one audit and safe problem response under retry and error. |
| F0-02 | Finish OBS-001, SEC-001 and UX-002 using the existing logger, contract registry and UI package. | `packages/observability`, `packages/contracts`, `packages/ui`, four backend entry points | Trace crosses HTTP → event → job; synthetic PII remains masked in error/log/export paths; every exposed status has an Indonesian label; exporter outage does not lose a command. OD-185 and retention policy remain gate decisions. |
| F0-03 | Finish PLT-004/005 on the existing PostgreSQL/BullMQ path, then build the DQ-001 foundation. Complete DQ-001 overdue notification after F0-08 delivers NTF-001. | `domains/platform`, `apps/integration-worker`, `packages/contracts`, reporting consumer | Duplicate, out-of-order, worker-kill, backoff, DLQ, audited replay and exception owner tests pass. DQ-001.AC01–04/AC06 and NC01–03, plus 100k active-item query evidence, pass before the notification slice; AC05 closes after F0-08. |
| F0-04 | Finish IDN-001/002/003/004 and RBAC-001/002/003, then APR-001. | `domains/identity`, `domains/platform`, `apps/api`, `apps/web` | Account/device lifecycle, MFA, revocation, default-deny scope, SoD and approval/delegation tests pass. Do not seed unresolved Appendix D groups as grants. |
| F0-05 | Finish PLT-008 experience APIs after authorization/contracts, then APR-002 browser inbox. | `apps/api`, `apps/web`, `packages/contracts` | One role-scoped screen returns labeled view data and `permittedActions` in one request; cross-branch data is absent; partial source failure is explicit; BFF writes no database table; approval browser happy/error paths pass. |
| F0-06 | Finish PLT-009/010 and DOC-001 using effective-dated configuration. | `packages/configuration`, `domains/platform`, `apps/api` | Admin writes are authorized and audited; `UNSET` remains fail-closed; flag rollout/expiry is testable; document numbers survive concurrency, retry and void without reuse. The document scheme and official branch code must be approved before live issuance. |
| F0-07 | Implement PLT-011 after OD-119/187; this unlocks hosted MED-001 and PLT-012 evidence. | Infrastructure, CI and runbooks | Three reproducible environments, secret handling and same-image deployment have linked hosted proof. Local Compose is only development evidence. |
| F0-08 | Finish MED-001, then DOC-002; finish NTF-001, DQ-001.AC05, ADM-008, OBS-002 and PLT-012 after their dependencies and OD-185/188. | Platform media/document/notification interfaces, Konsol Sistem BFF/UI, observability and recovery | Signed upload rules, immutable evidence, versioned PDF/copy print audit, in-app delivery, exception overdue notification, scoped admin workflows, health/lag alerts and managed restore/PITR pass API/browser/hosted checks. OD-123 printer/document choices gate actual templates. |
| F0-09 | Run §93 and Appendix L review; record every open ASM/KOSONG value and owner acceptance. | `docs/releases/F0.md`, feature/ADR/runbook records | Hosted CI and demonstrations linked, open exceptions owned, Engineering signature recorded. Gate remains OPEN until all required evidence exists. |

**Activation rule for early POS/WMS code:** F0 tickets do not reopen their API routes. When their F9/F11 dependencies are ready, the product ticket must map each route to an Appendix D permission, derive scope from its canonical resource, enforce state and SoD at the server, require idempotency where specified, test negative paths, then deliberately add that controller to the API registration allow-list. This prevents early development from silently changing the release sequence.

**Scheduling discrepancy to track:** DQ-001.AC05 requires an overdue notification, but the baseline places DQ-001 in S4 and NTF-001 in S5. DQ-001 can be built and tested in S4, but its full Appendix L status cannot close before the NTF-001 slice. The phase gate remains unchanged; record the dependency explicitly in the relevant tickets rather than marking DQ-001 done early.
