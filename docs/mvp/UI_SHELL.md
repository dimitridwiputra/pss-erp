# PSS web app shell: one frame for POS, ERP and Finance

Stream A built this on 2026-10-01 at the product owner's request ("make it like a proper SaaS").
It carries out DESIGN_SYSTEM §6.1 (desktop layout) and §7.1–7.2 (sidebar grouped by work, a screen
without permission is absent). Every desktop work screen (`/beranda`, `/kantor/*`, `/keuangan/*`)
sits in the same shell. `/kasir` stays a full-screen counter terminal with its own top bar.

## What exists

| Piece | Where | What it does |
|---|---|---|
| `AppShell` | `packages/ui/src/app-shell.tsx` | The frame. It has a collapsible sidebar (remembered per browser), a phone drawer, a breadcrumb, quick-jump (Ctrl/⌘ K) and the account menu. It is presentational and gets its links and router from the app. |
| `PageHeader`, `Panel` | `packages/ui/src/page-header.tsx` | The heading every screen starts with, and a titled surface for one block (a table, a form, a chart). `Panel flush` gives a table edge-to-edge. |
| `ThemeChoice`, `themeBootScript` | `packages/ui/src/theme-choice.tsx`, `theme.ts` | Terang, Gelap or Ikuti perangkat. Light is the default; dark is opt-in. The boot script in `app/layout.tsx` applies the choice before first paint. |
| Semantic tokens | `packages/ui/tokens.css` | `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-heading`, `--color-link`, `--color-primary`, `--color-border`, `--color-on-accent`, `--color-sidebar-*`. `:root[data-theme="dark"]` remaps them and the palette. |
| Building blocks | `packages/ui/components.css` | `pss-button(-primary/-secondary)`, `pss-filter-bar`, `pss-segmented`, `pss-date`, `pss-chips`, `pss-data-table` in `pss-table-scroll`, `pss-number`, `pss-pagination`, `pss-detail-grid`, `pss-side-stack`, `pss-facts`, `pss-totals`, `pss-form-field`, `pss-notice-success`, `pss-kpi-grid` with `KpiCard`. |
| Navigation registry | `apps/web/lib/navigation/work-screens.ts` | One list of work screens: key, label, description, href, **permission code**, section and icon. The sidebar, the quick-jump and the Beranda tiles all read it. |
| Shell BFF | `apps/web/app/api/experience/shell/route.ts`, `lib/experience/shell-view.ts` | `ExperienceShellViewSchema`: the viewer's permitted screens grouped by section, from identity's grants (RBAC-003). |
| Web wrapper | `apps/web/app/_shell/pss-app-shell.tsx`, `icons.tsx` | `<PssAppShell>` for a layout; icon names map to Lucide icons. |
| Beranda widgets | `apps/web/app/beranda/widgets.tsx` | A summary block on Beranda, shown when the viewer can open the screen it summarises. |

## Adopting it (OpenCode for `/kantor`, Codex for `/keuangan`)

1. **Layout.** Render the shell from your layout and put your providers inside it:

   ```tsx
   import '@pss/ui/components.css';
   import { PssAppShell } from '../_shell/pss-app-shell';

   export default function Layout({ children }: { children: ReactNode }) {
     return <PssAppShell><YourProviders>{children}</YourProviders></PssAppShell>;
   }
   ```

   `apps/web/app/kantor/layout.tsx` already does this with `KasirProviders`. OpenCode: merge your
   `KantorSessionProvider` into that file and drop `KantorShell`. `/keuangan` now uses
   `PssAppShell` and keeps its server-side `redirect('/masuk')` guard.
2. **Navigation.** Append one entry per screen to `workScreens` (append-only), with a concrete
   Appendix D permission code, never a role. Sections: `hari-ini`, `penjualan`, `kas`, `persediaan`,
   `data-utama`, `keuangan`, `laporan`. Icon names already mapped: `dasbor`, `barang`, `harga`,
   `pelanggan`, `stok`, `terima`, `penyesuaian`, `jurnal`, `buku-besar`, `neraca-saldo`,
   `laporan`, `neraca`, `pengecualian`, `periode`. Append to `shellIcons` for anything else. Set
   `tile: false` to keep a screen off the Beranda tiles.
3. **Screens.** Start with `<PageHeader eyebrow title description actions />`. Put each block in a
   `<Panel>`. Use `pss-data-table` for lists and `KpiCard` inside `<dl className="pss-kpi-grid">` for
   figures. Do not draw your own sidebar or top bar.
4. **Colours.** Use the semantic tokens, not `--pss-white`, `--gray-*` or `--pss-navy-*`, for new
   CSS. Text on a navy or red surface is `var(--color-on-accent)`. `pnpm ui:check` refuses raw hex
   outside `tokens.css`. Check every screen with Gelap on.
5. **Beranda.** Add a widget to `homeWidgets` in `apps/web/app/beranda/widgets.tsx` (append-only),
   keyed on the work screen it summarises: stock value (OpenCode), gross profit and trial balance
   (Codex).
6. **Tests.** CI mocks the BFF in the browser. Call `mockShell(page)` from
   `apps/web/tests/e2e/shell.fixture.ts` so the sidebar has entries. With `PSS_SCREENSHOT_DIR` set,
   `snapshot(page, name)` saves a full-page screenshot for review. On Beranda, links appear in both
   the sidebar and the tiles, so scope a lookup to `page.getByRole('main')`.

## The counter (`/kasir`)

The counter is a terminal: one dark top bar with the counter and shift, connection, clock, a
light/dark toggle and Beranda. The work sits below it: the scan field and katalog on the left, the
cart as a tall sticky column on the right with a large total. Keyboard shortcuts: **F2** scan field,
**F4** katalog search, **F9** Bayar. A scanner types into the focused field, and scans queue.

Product categories on the counter (a tabbed product grid) wait for master data to store a category
(MVP_PLAN §10, MVP-OD-25).
