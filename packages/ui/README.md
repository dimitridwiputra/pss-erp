# @pss/ui

Shared PSS design tokens from `docs/DESIGN_SYSTEM.md` §§3 and 5. Import `@pss/ui/tokens.css` once in an app root layout. Components also need `@pss/ui/components.css`. TypeScript consumers can use the typed tokens, `Button`, `TextField`, `TaskCard`, page templates A–D, `formatRupiah`, and `formatJakartaDate` from `@pss/ui`.

Run `pnpm storybook` from the repository root and open <http://localhost:6006> for four states of each current component and page template. Story data is illustrative only. Run `pnpm test:a11y` for the four empty template WCAG 2.2 AA checks (install Chromium first with `pnpm --filter @pss/web exec playwright install chromium`). This is still partial UX-001: selection/scan/exception/confirmation/toast/table components and visual regression coverage remain. No business logic belongs in this package.
