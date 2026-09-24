# PSS Operating Platform

Greenfield implementation of the PSS operating and finance platform. The product baseline is [PRODUCT_PRD.md](docs/PRODUCT_PRD.md); the rollout order is [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), then [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) before editing.

## Current status

The repository has a runnable **PLT-001 platform skeleton**, partial **PLT-003 contracts**, initial **PLT-002 fitness checks**, a partial **PLT-007 API error boundary**, and **UX-001 design tokens**. The five processes expose health endpoints; the API health response uses the shared contract. Appendix C's 164 event names are cataloged, but only `DELIVERY_ORDER_CLOSED` v1 has a validated payload schema. There are no operational records, login, finance posting, or integrations yet. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for verified and pending work.

## Requirements

- Node.js 24.19.0 and pnpm 11.19.0
- Docker with Compose for local PostgreSQL/PostGIS, Redis, MinIO, and Keycloak

The local MinIO image is a pinned community build of the MinIO source because the former `minio/minio` Docker Hub tag is unavailable. This choice applies only to local development; production object storage is part of Sprint 0 infrastructure decisions.

## Start locally

```bash
pnpm install
pnpm dev:up
```

`pnpm dev:up` starts local services and all five apps. It also locates Docker Desktop installed at `~/Applications/Docker.app` on this Mac. Open <http://localhost:3000>. Stop the app processes with Ctrl+C; local service containers remain running. If the Docker CLI is not on your PATH, stop containers with `~/Applications/Docker.app/Contents/Resources/bin/docker compose down` from this directory. No production credentials are included.

If Docker is unavailable and you only need the skeleton health endpoints, run `pnpm dev` after install. The services do not yet depend on their databases.

| Deployable | Port | Health |
|---|---:|---|
| web | 3000 | `/health/live` |
| api | 4000 | `/health/live` |
| finance-api | 4001 | `/health/live` |
| integration-worker | 4002 | `/health/live` |
| geo-service | 4003 | `/health/live` |

Each process also exposes `/health/ready`. Readiness currently means the process has started; dependency probes belong to later F0 work.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm ui:check
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

`contracts:check` checks PRD catalog synchronization, generated OpenAPI/event documentation, and checked-in event/API compatibility baselines. `architecture:check` enforces initial import boundaries. `db:check` rejects selected destructive and wrongly owned SQL migrations; there are no real migrations yet. `ui:check` enforces initial token and copy rules. Integration and e2e checks still validate only the scaffold. The remaining PLT-003/PLT-002 scope and UX-001 fitness functions are pending.

Create a domain with `pnpm gen:domain <kebab-case-name>`. Existing domains are already scaffolded.
