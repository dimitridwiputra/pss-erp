# PSS Operating Platform

Greenfield implementation of the PSS operating and finance platform. The product baseline is [PRODUCT_PRD.md](docs/PRODUCT_PRD.md); the rollout order is [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), then [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) before editing.

## Current status

The repository has a runnable **PLT-001 platform skeleton**, partial **PLT-003 contracts**, initial **PLT-002 fitness checks**, a partial **PLT-007 API error boundary**, and **UX-001 design tokens**. The five processes expose health endpoints; the API health response uses the shared contract. Appendix C's 164 event names are cataloged, but only `DELIVERY_ORDER_CLOSED` v1 has a validated payload schema. Sprint 3–4 foundations now include an OIDC/JWKS verifier, identity account lookup, protected API `/me`, and a transactional inbox wrapper. There are no operational records, web login, finance posting, or integrations yet. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for verified and pending work.

## Requirements

- Node.js 24.19.0 and pnpm 11.19.0
- Docker with Compose for local PostgreSQL/PostGIS, Redis, MinIO, and Keycloak

The local MinIO image is a pinned community build of the MinIO source because the former `minio/minio` Docker Hub tag is unavailable. This choice applies only to local development; production object storage is part of Sprint 0 infrastructure decisions.

## Start locally

```bash
pnpm install
pnpm dev:up
```

`pnpm install` also enables the repository's small local pre-commit check set through Git's native hooks. CI runs the full checks even if a local hook is bypassed.

`pnpm dev:up` starts local services, applies audit, platform, and identity database migrations, and starts all five apps. It also locates Docker Desktop installed at `~/Applications/Docker.app` on this Mac. Open <http://localhost:3000>. Stop the app processes with Ctrl+C; local service containers remain running. If the Docker CLI is not on your PATH, stop containers with `~/Applications/Docker.app/Contents/Resources/bin/docker compose down` from this directory. No production credentials are included.

In local development, open <http://localhost:3000/fitur> to browse all **280 PRD features** with their phase, sprint, and current implementation status. The home page links there as well. The directory is read-only and only appears in development; it does not create transaction screens for features that have not been built.

For the shared component and page-template preview, run `pnpm storybook` in a second Terminal window and open <http://localhost:6006>. The stories show four states of each current `@pss/ui` component and templates A–D with illustrative content; they are not ERP workflows. Run `pnpm test:a11y` to check all 34 template/control states with Playwright and axe (first install Chromium with `pnpm --filter @pss/web exec playwright install chromium`). Run `pnpm test:visual:docker` to compare the eight reviewed template snapshots in pinned Linux Chromium; Docker Desktop must be running. The script starts and stops its own browser container. Run the a11y and visual commands **one at a time** because each manages Storybook on port 6006.

If Docker is unavailable and you only need the skeleton health endpoints, run `pnpm dev` after install. The services do not yet depend on their databases.

| Deployable | Port | Health |
|---|---:|---|
| web | 3000 | `/health/live` |
| api | 4000 | `/health/live` |
| finance-api | 4001 | `/health/live` |
| integration-worker | 4002 | `/health/live` |
| geo-service | 4003 | `/health/live` |

Each process also exposes `/health/ready`. Readiness currently means the process has started; dependency probes belong to later F0 work.

`GET http://localhost:4000/me` and `GET http://localhost:4000/me/permissions` require a Bearer token signed by the configured IdP and an active record in `identity.user_account`. The permissions endpoint reads effective assignments from `identity.role_assignment`; it never trusts role claims in the token. Set `PSS_OIDC_ISSUER`, `PSS_OIDC_AUDIENCE`, and `PSS_OIDC_JWKS_URI` for the API process before using these routes. The local Keycloak container now imports a `pss-local` realm with a public `pss-web` client that requires S256 PKCE. Check it with `pnpm idp:check:local` after Docker is ready. There is no user seed or web login yet, so protected routes are verified by isolated HTTP/JWKS/PostgreSQL integration tests. A missing token returns `UNAUTHENTICATED`; missing OIDC configuration returns `DEPENDENCY_UNAVAILABLE`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm ui:check
pnpm features:check
pnpm test
PSS_TEST_DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm test:integration
pnpm idp:check:local
pnpm test:e2e
pnpm test:a11y
pnpm test:visual:docker
pnpm build
pnpm dr:rehearse:local
```

`contracts:check` checks PRD catalog synchronization, generated OpenAPI/event documentation, and checked-in event/API compatibility baselines. CI also compares these contracts with `origin/main`; locally, use `PSS_CONTRACT_BASE_REF=origin/main pnpm contracts:check` after fetching that ref. `architecture:check` resolves workspace aliases and rejects selected domain imports, direct cross-domain SQL table access, and literal role-name authorization comparisons. `db:check` checks the five current audit/platform/identity migrations. `ui:check` rejects raw hex, selected English button labels, and simple raw enum rendering. The integration command above uses the disposable local Compose database started by `pnpm dev:up`. The suite exercises audit, outbox, inbox, idempotency, identity, and the request error boundary; it does not yet cover a business workflow. `test:e2e` remains a scaffold. `dr:rehearse:local` tests an isolated restore with synthetic data and cleans up its temporary databases; it does not certify production backup recovery. See [Sprint 0–2 evidence](docs/releases/S0-S2-evidence.md) and [Sprint 3–5 evidence](docs/releases/S3-S5-evidence.md) for remaining Definition of Done items.

To verify a deployable container after building it, run these commands from the repository root (replace `api` with `web`, `finance-api`, `integration-worker`, or `geo-service` as needed):

```bash
docker build --file apps/api/Dockerfile --tag pss-api:local .
bash scripts/smoke-image.sh api local
```

Create a domain with `pnpm gen:domain <kebab-case-name>`. Existing domains are already scaffolded.
