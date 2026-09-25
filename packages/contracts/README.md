# @pss/contracts

Shared Zod contracts for API responses, event envelopes and versioned payloads, and decimal/date wire formats. The package contains validation only; it must not import a domain.

Run `pnpm --filter @pss/contracts build` to compile the package and generate `docs/api/openapi.json`, `docs/events/catalog.json`, and `docs/events/schemas.json`. The build also refreshes the source-preserving catalog in `docs/registry/catalog.json`. The root `pnpm contracts:check` command checks generated output and event/API compatibility baselines. Set `PSS_CONTRACT_BASE_REF=origin/main` to also compare generated event schemas and OpenAPI with the main branch; CI fetches main and requires this check. If that ref is unavailable, the gate fails instead of skipping the comparison.

An event name in the catalog is not permission to publish. Add a versioned payload schema to `eventSchemaRegistry`, then validate at the publication boundary with `parseEventForPublication`. `producer` is mandatory on every event, per the Product Owner's 24 September 2026 clarification.
