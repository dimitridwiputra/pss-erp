# Sprint 0–2 development evidence — 27 September 2026

**Gate state: open.** This is an evidence register against the existing PRD and Implementation Plan, not a release approval. Sprint 0 is a management and access preparation sprint; S1 covers PLT-001; S2 covers OBS-001, PLT-002, PLT-003, PLT-011, and UX-001. The PRD Appendix L Definition of Done applies to each feature. A local green test is not evidence of hosted CI enforcement, cloud deployment, or business acceptance.

## Completed and verified in this checkout

| Criterion | Evidence | Remaining limit |
|---|---|---|
| PLT-001.R01–R06, AC02–AC05 | Pinned Node/pnpm workspace; five buildable Dockerfiles and `/health/live`; domain generator, required scripts, README, PR template, version/dependency/secret fixture tests. Five images built and passed `scripts/smoke-image.sh` locally. A separate local clone of commit `25e25b9` passed `pnpm install --frozen-lockfile` and `pnpm exec turbo run lint typecheck test build` (33 package tasks). | AC01 still needs `pnpm dev:up` from a fresh clone and a hosted CI run. Existing user-facing development processes occupy ports 3000/4000, so this review did not replace them. Branch protection is not configured because this checkout has no Git remote. |
| PLT-002.AC01 and import boundary | The architecture check now resolves actual workspace package names, catches `@pss/audit` from Platform and `@pss/orders/domain/*` from another domain, and rejects direct SQL references to a different owned schema. The real Platform→Audit dependency was removed. | The checker is static and only sees direct `.query` string literals for SQL. Mutating-command/audit, consumer/inbox, finance immutability, PR report, pre-commit, and hosted enforcement are not complete. |
| PLT-002.AC02–AC04, AC06 subset | Existing migration, event-contract, literal identity, and token checks pass their negative fixtures. UI check now also rejects raw enum text and direct `state`/`status` JSX rendering. Lint rejects unexplained `any`; production dependency audit reported no known high-severity advisory locally. | These checks do not establish all ARC §20 fitness rules. |
| PLT-003.AC01–AC04 subset | PRD Appendix C event names and the one publishable payload are generated and guarded; OpenAPI and event document compatibility tests pass; invalid requests return problem+json. | Business endpoint and event payload schemas, PII classification-driven masking, and full registry runtime use are not complete. |
| OBS-001.R01/AC04 subset | Four backend shells return request/correlation headers and JSON allow-list HTTP logs; synthetic PII/token fixtures do not appear in those HTTP logs. | No end-to-end order trace, OpenTelemetry exporter, event/job propagation, dynamic level setting, retention, or overhead benchmark. OD-185 remains open. |
| UX-001.AC01, AC03, AC04, TS02 subset | Token/label checks and four Storybook states exist; `pnpm test:a11y` passed all 34 Playwright/axe cases when run alone. Eight reviewed Linux Chromium snapshots cover templates A–D in default/error states; `pnpm test:visual` passed all eight without snapshot updates. | Full verb-label policy and actual product-screen acceptance remain open. |
| S0.9 | Product Owner selected Cimahi Operations HO as the pilot, with Cimahi, Sukabumi, Cianjur, and Subang documented as current distribution centers. | Official codes, addresses, legal entity, and activation approval remain unset. |

## Sprint 0 and S2 dependencies that prevent Definition of Done

| Plan item | Current evidence | Required closing evidence |
|---|---|---|
| S0.1, S0.10, S0.11 | No named business owners, onboarding participants, or approved capacity baseline in repository. | Management records names, cadence, test participants, and confirms/revises IP-ASM-01…10. |
| S0.2–S0.4; PLT-011 | Jakarta region and managed-services principles are in the PRD. Vendor/account (OD-119), IaC tool (OD-187), observability backend/cost (OD-185), and RPO/RTO (OD-188) are still open. | Accepted ADR/OD, provisioned organization account, reviewed IaC plan, recreated staging, drift test, masked seed, and same-image promotion proof. No account or production environment is claimed here. |
| S0.5–S0.6; PLT-001/002 | Repository and CI files exist; coding agent can run checks locally. CI now has a five-image build/smoke matrix and production dependency audit. `git remote -v` has no entries. | Remote repository, first successful hosted CI, protected `main` with required checks/review, board and PR workflow. |
| S0.7–S0.8 | Draft requests are in `docs/sprint-0-data-requests.md`; no external request was sent. | Named Ops/IT and Finance owners send and acknowledge the ND6/FoxPro and Finance requests; record masked samples and access channel. |
| PLT-002.AC05/NC01/TS01–TS04 | Alias, SQL, migration, contract, UI, and lint fixtures are present. A Git-native pre-commit subset is installed by `pnpm install`. | Register and test every required fitness rule, including command audit and inbox, plus hosted branch protection, reviewed exceptions, CI metrics, and nightly checks. |
| PLT-003.AC05 | HTTP logger logs safe allow-listed metadata. | Schema-marked PII redaction fixture and a real payload logging boundary. |
| OBS-001.AC01–AC03/TS02–TS04 | HTTP request IDs and safe local JSON logging are present. | End-to-end trace through event/job, non-blocking exporter, PII classification, outage test, p95 overhead result, and backend/retention decisions. |

## Reproducible local verification

From the repository root with Docker running:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm ui:check
pnpm features:check
pnpm secrets:check
pnpm audit --prod --audit-level high
pnpm test
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm test:integration
pnpm test:a11y
pnpm test:visual:docker
pnpm build
```

The PostgreSQL URL above points only to the local Compose development database. Run `pnpm dev:up` in another terminal to start it if needed. Run `pnpm test:a11y` and `pnpm test:visual:docker` separately: both manage Storybook on port 6006. The visual script starts the pinned Playwright Linux browser container and cleans it up. `pnpm test:e2e` is now a real Playwright gate covering the POS preview and PSS Kasir offline banner; it does not yet certify an order, approval, or WMS workflow.

The current engineering result is a stronger local foundation with reproducible container health and architecture checks. **S0, S1, and S2 cannot be marked Definition of Done** until their remaining criteria and external gate evidence above are recorded.
