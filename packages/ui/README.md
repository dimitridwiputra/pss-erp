# @pss/ui

Shared PSS design tokens from `docs/DESIGN_SYSTEM.md` §§3 and 5. Import `@pss/ui/tokens.css` once in an app root layout. Components also need `@pss/ui/components.css`. TypeScript consumers can use the typed tokens, `Button`, `TextField`, `TaskCard`, `SelectionCardGroup`, `StatusPill`, `ScanScreen`, `ExceptionSheet`, `ConfirmationDialog`, `Toast`, presentational `Table`, page templates A–E, and standard loading/empty/error/offline/sync states from `@pss/ui`. Formatting is provided by `formatRupiah` and `formatJakartaDate`. Selection uses native radio controls, so its choices work with pointer, keyboard, and assistive technology.

Run `pnpm storybook` from the repository root and open <http://localhost:6006> for four states of each current component and page template. Story data is illustrative only. Run `pnpm test:a11y` for WCAG 2.2 AA checks and selection interaction checks (install Chromium first with `pnpm --filter @pss/web exec playwright install chromium`). The standard states have four targeted axe checks. No business logic belongs in this package.

## Status vocabulary (UX-002)

`status-vocabulary.ts` is the single source of Indonesian status copy and the only place a state
may be turned into something a user sees. `resolveStatus({ stcCode, state, role? })` returns
`{ code, label, tone, icon, description, known }`; an unknown state returns the
"Status tidak dikenal" fallback and never shows the raw code.
`missingStatusVocabularyEntries` backs the completeness gate in `pnpm ui:check`. See
`docs/api/ux-002-status-vocabulary.md`.
