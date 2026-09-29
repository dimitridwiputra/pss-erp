# UX-002 — Status Vocabulary Registry

**Source of copy:** PRD Appendix M (`statuses`) and M.2 (offline sync statuses), generated into
`@pss/contracts`'s `registryCatalog.statuses` / `registryCatalog.offlineStatuses` by
`scripts/generate-registry-catalog.mjs`. **Implementation:**
`packages/ui/src/status-vocabulary.ts`. **CI gate:** `pnpm ui:check`
(`checkStatusVocabulary` in `scripts/check-ui.mjs`) and `tests/ux-002-status-vocabulary.test.ts`.

## Shape

```ts
{ stcCode, state, role? } -> { label, tone, icon, description }
```

`resolveStatus({ stcCode, state, role? })` returns `StatusView { code, label, tone, icon, description, known }`,
the object the BFF sends in an API response (UX-002.R02). `tone ∈ {neutral, info, success,
warning, danger}` (UX-002.BR02). `role: 'FRONTLINE'` selects the PSS Sales/Gudang/Antar wording;
the unroled entry is the desktop default (UX-002.A1, AC04).

`stcCode` is the aggregate name used by PRD Appendices E and M (`SalesOrder`, `PosSale`,
`WarehouseTask`, …), so a registry key joins directly to the generated PRD catalog.

## Why two tables

`statusVocabulary` holds one entry per real state of a state machine (Appendix E).

`derivedStatusVocabulary` holds the Appendix M rows that are *not* a single state: a composite of
several dimensions (`SalesOrder · VALIDATED + CreditDecision ON_HOLD`), a derived (◇) status
(`Cash · belum disetor`, `ProofOfDelivery · MISSING`), a placeholder label
(`Receivable · OVERDUE_*` → `Terlambat {n} hari`), or the `external` badge tone
(`SalesOrder · VALIDATED (observed)`). A BFF resolves those after collapsing dimensions,
applying Appendix M's priority order `danger > warning > info > success > neutral`.
`fillDerivedStatusLabel` fills `{n}` / `{sumber}` from values the caller already computed.

The `external` tone exists only in the derived table because UX-002.BR02 restricts the five
status tones; `external` is a source badge, not a status tone.

## Unknown states

`resolveStatus` returns `unknownStatusEntry` — "Status tidak dikenal", tone `neutral`, icon
`circle-help`, description "Muat ulang halaman. Bila masih muncul, hubungi admin." — and
`known: false`. The raw state is returned only as the `code` field for telemetry; it is never
the visible label (UX-002.E2, NC01, NC03).

## Completeness gate

`missingStatusVocabularyEntries` reads the state unions the shipped `@pss/contracts` schemas
declare (`readStatusStateUnions`) and fails `pnpm ui:check` for any state that has neither a
registry entry nor an explicit `pendingStatusLabels` acknowledgement. Adding a state to a
contract schema without a label fails CI.

## Known gaps — GAP-23

`pendingStatusLabels` lists the states the API can return that Appendix M does not yet label:
`PosTender.ACCEPTED`, both `PosTerminal` states, all three `KasirCatalogItem` states, the
`APPLIED` / `APPLIED_WITH_CONFLICTS` sync batch results (POS and WMS), `WarehouseTask.CREATED` /
`IN_PROGRESS` / `COMPLETED` / `CANCELLED`, both `WarehouseLocation` states, all three
`StockDiscrepancy` states, and all three `ExceptionItem` states.

Each entry carries a reason. Labels are Product/Ops copy (UX-002 "WRITE AUTHORITY: engineer
tidak mengarang label"; AGT §18), so these are acknowledged rather than invented. The gate fails
if a pending entry stops matching a real contract state, so the list cannot go stale silently.

## Not yet implemented

- **BFF wiring (UX-002.AC02/AC03).** No endpoint sends a `StatusView` yet. `resolveStatus` is the
  entry point a BFF query should call. No `<StatusPill>` wrapper was added: every shared `.tsx`
  component in `packages/ui` requires a Storybook story in `apps/web/stories`, which is outside
  this change's file ownership.
- **Error-code copy (UX-002.AC05, R06).** `findErrorCode` in `@pss/contracts` still resolves
  copy from the generated catalog; the completeness assertion for it belongs in
  `contracts:check`, which this change does not touch.
- **DSY §14.3 term dictionary lint (UX-002.R05/TS04).** Not implemented.
- **E2E DOM scan for raw enums (UX-002.TS03).** Not implemented; `check-ui.mjs` covers the
  static JSX cases only.
- **Batched registry import at build time (UX-002.R03).** The registry ships as a compiled
  module inside `@pss/ui` rather than a generated JSON artifact.
