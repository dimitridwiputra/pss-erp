# MVP-OD-5 — POS API exposure for the demo build

Date: 1 October 2026
Status: **Proposed; in effect for the demo build only.** Engineering owner to accept. Production stays blocked.
Plan reference: `docs/mvp/MVP_PLAN.md` §10, MVP-OD-5.

## Context

`docs/NEXT_IMPLEMENTATION_PLAN_2026-09-29.md` §2 removed `PosController` from the deployable API. Its routes authenticated the caller but never checked permission or scope. They trusted raw bodies, and `POST /pos/shifts/:id/cash-handover` did not even read the caller. The same section allows local work to keep the controller registered only behind "an explicit server-side disabled gate that returns a stable error for all POS/WMS routes". A hidden navigation item or a client flag is not enough.

The MVP demo (1–13 October 2026) needs the PSS Kasir counter flow running on the real backend. POS is F11 in the PRD, and its F9/F11 dependency gates are not met. So this is a demo exposure, not a release.

## Decision

1. **One server-side switch.** `PSS_DEMO_POS_ENABLED` must be exactly `true` for any `/pos/*` or `/kasir/*` API route to run. Unset, empty, `1`, `TRUE` or anything else counts as off.
2. **Refused in production.** When `NODE_ENV` is `production`, the routes are off whatever the flag says. A production deploy cannot turn them on through configuration.
3. **Stable refusal.** A disabled route answers `403` `application/problem+json` with code `FEATURE_DISABLED`, `retryable: false`. This code is registered in PRD Appendix F.2 ("Fitur belum aktif"). The guard runs before any pipe or handler, so a disabled route reveals nothing about its input shape or data.
4. **Enforced at class level.** `DemoPosFeatureGuard` (`apps/api/src/demo-pos-guard.ts`) sits on the `PosController` class with `@UseGuards`, so it also covers any route added later.
5. **Enforced by the gate.** `scripts/check-api-controller-registration.mjs` allows `PosController` in the API module only when that class carries `@UseGuards(DemoPosFeatureGuard)`. It rejects a missing guard, a different guard, a guard on a method only, and a guard on another class (`tests/api-controller-registration.test.ts`).
6. **The switch is not the authorization.** It only decides whether the routes exist. Each route must still pass task 6 of the stream A plan before `PosController` is registered: validated body, permission × scope check, ownership of every supplied ID resolved from its canonical record, ADR-0013 idempotent command, and negative API tests.

`scripts/check-command-fitness.mjs` also changed. It read a hardcoded list of four controller files, so registering `PosController` (in `pos.controller.ts`) would have skipped every per-route check without a word. It now reads every source file in `apps/api/src` and inspects exactly the controllers `main.ts` registers.

## Consequences

- The demo laptop sets `PSS_DEMO_POS_ENABLED=true` for `apps/api` (`docs/mvp/DEMO_RUNBOOK.md`). Every other environment, including CI's default, runs with POS off.
- `apps/api/tests/demo-pos-guard.integration.test.ts` reads every route from the controller's Nest metadata. It proves each route refuses while off, including in production with the flag on, and that the request reaches authentication while on.
- The web `/kasir` screen must show the `FEATURE_DISABLED` problem as a readable state, not a crash (DESIGN_SYSTEM error states).

## Not decided here

- Whether POS routes are activated for a real branch. That is the F11 release gate and needs the PRD Appendix L evidence, not this switch.
- WMS. `WmsController` is registered without this switch under its own reviewed route guards (§2 of the 29 September plan). This decision does not change it.
- An environment tier other than `production` that should also refuse, such as a hosted staging. There is no hosted environment in the MVP (plan §9). Revisit when one exists.
