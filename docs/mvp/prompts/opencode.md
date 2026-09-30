# Prompt: OpenCode (stream C: back office)

You are stream C of three agents building the PSS MVP demo in parallel (Claude = foundation/POS/sales/cash, Codex = accounting). Work in a git worktree on branch `mvp/backoffice`, created from `mvp/integration`.

**Read first, in this order:** `AGENTS.md`, `docs/mvp/MVP_PLAN.md` (your contract with the other agents), `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`, `docs/adr/ADR-0013-single-command-pipeline.md`, then `DOMAIN.md` for `master-data`, `commercial`, `inventory`, `wms`.

**You own:** `domains/master-data`, `domains/commercial`, `domains/inventory` (including costing and inventory events), and the web routes `/kantor/*` **except** `/kantor/penjualan` and `/kantor/setoran-kas` (Claude's). You may make exactly one WMS change: pass `unitCost: null` explicitly where WMS calls `receiveStock`. Do not edit `packages/contracts/src/events/index.ts`; Claude owns it and merges the plan §5 schemas by end of Day 1. Hotspot files are append-only (plan §4). Never read or write another domain's tables.

## Day 1
1. Forward-only migration in `inventory`: add `avg_unit_cost numeric(18,4) NULL` to `stock_balance`, and `unit_cost` / `total_cost` to `stock_movement`. Nullable columns mean "unvalued". Include a backfill note: existing rows stay NULL, meaning unvalued.
2. Moving-average costing as a pure domain rule with unit tests:
   - receipt with a cost → new average;
   - receipt without a cost → average unchanged and the movement unvalued;
   - issue/adjustment valued at the current average (null if the balance was never valued);
   - rounding: 4 decimals for unit cost, 2 for totals, using `decimal.js`.
   - Record "moving average per warehouse × product × UoM" as MVP-OD-4 in plan §10 if it isn't already there.

## Days 2–3: domain commands and events
3. `master-data`: `createProduct`, `updateProduct`, `addProductBarcode`, `addProductUom`, `listCustomers` (paginated search), and `getProduct`. Each has Zod input, an audit entry, and is idempotent through the ADR-0013 pipeline. Barcodes are unique per organization, and a duplicate gives a stable error code with an Indonesian message.
4. `commercial`: `setPriceListItem` (product × UoM × price on a DRAFT list), `listPriceListItems`, plus the existing `activatePriceList`. A price change on an active list creates a new list version rather than editing in place. If the PRD requires approval for price changes, stop and record it as an open decision instead of inventing one.
5. `inventory`: `receiveStock` accepts an optional `unitCost` and a `sourceType`; `adjustStock` requires a `reasonCode` from a reference table (seed demo reasons: RUSAK, HILANG, SELISIH_HITUNG, KOREKSI). Add `listStockBalances` (with value and average cost) and `listStockMovements` queries. Emit `INVENTORY_RECEIVED`, `INVENTORY_ISSUED` and `INVENTORY_ADJUSTED` (plan §5 payloads) through `appendOutboxEvent` in the same transaction as the movement. That includes the issue path POS checkout/handover already calls, so a sale produces `INVENTORY_ISSUED` with a cost. Add replay/idempotency tests.

## Days 3–5: API
6. New controllers in `apps/api/src/backoffice-*.controller.ts`, each registered with one append-only line. Every route has: an authenticated caller, a permission × scope check using the plan §7 role codes, Zod validation, a required `Idempotency-Key` on mutations, canonical ownership lookup of supplied IDs, pagination and allow-listed sort/filter, and negative API tests (unauthenticated, wrong role, wrong organization, replay). Contracts go in `packages/contracts/src/api/backoffice-*.ts`.

## Days 4–7: `/kantor` UI
7. Following `docs/DESIGN_SYSTEM.md`: Indonesian copy, no raw enums or backend jargon, loading/empty/error states, TanStack Table for lists, React Hook Form + Zod for forms. All calls go through `/api/bff/core/*` (Claude's proxy).
   - **Barang**: list/search, create/edit, barcodes, units
   - **Harga**: price list items and activation
   - **Stok**: balance per warehouse with value, movement history
   - **Terima Barang**: goods receipt with unit cost, by `gudang.demo` or `admin.demo`
   - **Penyesuaian Stok**: adjustment with a reason
   - **Pelanggan**: read-only list
   - A `/kantor` layout with navigation that also links Claude's **Penjualan** and **Setoran Kas**
8. **Dasbor Harian** at `/kantor`: today's sales, cash not yet deposited (Claude's summary endpoints, available Day 5), low stock (your query, threshold from configuration, not hard-coded), and today's and this month's gross profit (Codex's finance summary, available Day 5). Compose them in a BFF route handler: each tile degrades to its own error state if one source is down, and no domain logic lives in the component.

## Days 8–9: freeze
9. Replace Claude's Day 1 synthetic product seed with a richer demo catalog of about 20 FMCG items across 4 categories, with barcodes, units (PCS/KARTON), prices and costed opening stock. Deliver it as a receipt through `receiveStock`, not raw SQL, so the opening inventory also posts to the GL.
10. Playwright paths: create product → set price → receive with cost → product appears in the POS catalog. Plus one exception path: duplicate barcode.
11. Update `DOMAIN.md` for `master-data`, `commercial` and `inventory` (commands, queries, events, tables, open decisions).

**Rules:**
- Never invent a business rule. If one is missing, stop and add it to plan §10.
- Money and cost use `numeric` in the DB and `decimal.js` in TS, never float.
- No business logic in controllers or components.
- Run the full gate list from plan §3 before every merge.
- End each day with a short report: what merged, tests run, what's blocked, and what you need from the other streams.
