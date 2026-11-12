# Prompt: Claude Code (stream A: foundation, POS, sales and cash)

You are stream A of three agents building the PSS MVP demo in parallel (Codex = accounting, OpenCode = back office). Work in a git worktree on branch `mvp/foundation-pos`, created from `mvp/integration`.

**Read first, in this order:** `AGENTS.md`, `docs/mvp/MVP_PLAN.md` (your contract with the other agents), `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`, `docs/adr/ADR-0013-single-command-pipeline.md`, then `DOMAIN.md` for `pos`, `invoicing`, `payments`, `fulfillment`, `identity`. Also read `docs/NEXT_IMPLEMENTATION_PLAN_2026-09-29.md` §0, which explains why `PosController` was removed.

**You own:** `domains/pos`, `invoicing`, `payments`, `orders`, `fulfillment`, `identity`; `packages/contracts/src/events/index.ts`; `apps/web/lib/bff/*`; the web routes `/kasir`, `/pos-preview`, `/kantor/penjualan`, `/kantor/setoran-kas`, and the `/beranda` tiles. Do not edit files other streams own (plan §4). Hotspot files are append-only.

## Day 1: unblock the others (merge by end of day)
1. Fix `tests/integration/pos-checkout-flow.integration.test.ts`: remove the duplicate `applyAuditMigrations` import and the second call, and make `applyMigration` actually run its SQL. Both tests must pass.
2. Implement the v1 payload schemas from plan §5 in `packages/contracts/src/events/index.ts` and register them in `eventSchemaRegistry`. Add contract tests: a valid payload passes, extra fields and float money fail, and the wrong producer is rejected.
3. Web BFF proxy `apps/web/lib/bff/`: a Next route handler that forwards `/api/bff/core/*` → `PSS_API_BASE_URL` and `/api/bff/finance/*` → `PSS_FINANCE_API_BASE_URL`. It attaches the session access token (reuse `lib/access-token.ts` and the pattern in `lib/experience/transport.ts`), passes `Idempotency-Key` through, and never exposes the token to the client. Point `kasirFetch` at it and remove the `pos`/`kasir` dev rewrites.
4. Demo roles and users from plan §7: permission mapping in `identity` using PRD Appendix D codes, and users in the local Keycloak realm seed. Record the permission code for each role in plan §7.
5. Demo switch `PSS_DEMO_POS_ENABLED`: a server-side guard. When off, every `/pos` and `/kasir` route returns a stable `FEATURE_DISABLED` problem response. It fails closed when `NODE_ENV=production`. Update `check-api-controller-registration.mjs` so `PosController` is allowed only together with the guard, and keep its fixture that rejects unguarded registration. Write `docs/decisions/2026-10-01-mvp-demo-pos-exposure.md` (MVP-OD-5).

## Days 2–4: POS on the real backend
6. Harden every `PosController` route before registering it:
   - Zod-validate every body. The `addLine` spread currently lets the body override `organizationId`/`priceListScope`; fix that.
   - Run a permission × scope check per route.
   - Resolve ownership of each supplied ID from its canonical record: the terminal, shift and sale must belong to the caller's organization/branch, and the shift must be the caller's own.
   - Use the ADR-0013 idempotent command pipeline with a required `Idempotency-Key`.
   - `cash-handover` must read and authorize the caller.
   - Add negative API tests: unauthenticated, wrong role, wrong branch, wrong organization, stale state, replay.
7. Add the endpoints the UI needs: product search for the catalog (via `@pss/master-data` `searchProducts`), update/remove line, receipt print, and a sale detail query.
8. Wire the `/pos-preview` visual design to the real API as the production `/kasir` screen, for the counter flow only: Buka Shift → scan or pick → cart → Bayar → Terima Uang (change shown) → Struk → Serah Barang (logged in as `gudang.demo`) → Tutup Shift → Serah Kas. Hide the customer, order-list and return menus. Include loading, empty and error states, Indonesian copy, 48 px touch targets.
9. Emit `INVOICE_ISSUED`, `PAYMENT_RECEIVED` and `CASH_CUSTODY_VERIFIED` through `appendOutboxEvent` in the same transaction as the fact. Add idempotency/replay tests.

## Days 5–7: sales, cash and the full chain
10. Endpoints and screens for `/kantor/penjualan`: POS sales and invoice list (paginated, filter by date/shift/cashier), detail, reprint marked "SALINAN". And for `/kantor/setoran-kas`: pending handovers and verification by `keuangan.demo`, showing the variance and requiring a reason code. Expose summary queries for OpenCode's dashboard: today's sales total/count and cash not yet deposited. Publish their contracts in `packages/contracts/src/api/pos-*.ts` by Day 5.
11. Root test `tests/integration/mvp-full-chain.integration.test.ts`: receipt with cost → sale → handover → close → verify. Assert the events and, once Codex's consumer is merged, balanced journals and a trial balance that ties.

## Days 8–9: freeze and rehearse
12. Playwright demo path covering all five demo users, plus two exception paths: insufficient stock, and a wrong-branch sale ID.
13. `docs/mvp/DEMO_RUNBOOK.md`: start commands, reset and seed, the demo script click by click, known limitations (plan §9), and a fallback if a service is down.
14. Update `domains/pos/DOMAIN.md` and `docs/IMPLEMENTATION_STATUS.md`.

**Rules:**
- Never invent a business rule. If one is missing, stop, add it to plan §10, and use the plan default only if one is listed.
- Every mutation must be audited and idempotent.
- No cross-domain SQL.
- Run the full gate list from plan §3 before every merge.
- End each day with a short report: what merged, tests run, what's blocked, and what you need from the other streams.
