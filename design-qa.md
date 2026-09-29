# POS UI preview design QA — 29 September 2026

## Result

**Passed for a local visual prototype.** The desktop and mobile layouts follow the supplied POS references, and the core sample order path works with sample data. This result does not close F1, F11, or any production POS gate. The preview is available only in development at `/pos-preview`; a production build returned HTTP 404 for that route.

## Visual sources and comparison

- Desktop dashboard source: `/Users/rpay/Downloads/ChatGPT Image Sep 29, 2026, 07_14_02 PM-1.png` (1672 × 940). [Side by side comparison](docs/visual-qa/pos-preview/comparison-desktop-dashboard.png) with the implemented [desktop screenshot](docs/visual-qa/pos-preview/desktop-dashboard.png) at 1672 × 940.
- Mobile flow source: `/Users/rpay/Downloads/ChatGPT Image Sep 29, 2026, 07_21_27 PM.png` (ten screen collage, 1536 × 1024). [Home screen comparison](docs/visual-qa/pos-preview/comparison-mobile-home.png) with the implemented [390 × 844 screenshot](docs/visual-qa/pos-preview/mobile-home.png).
- Other desktop source images supplied for customer selection, order entry, catalog, review, success, orders, detail, payment, and returns were compared against the corresponding local screenshots in [docs/visual-qa/pos-preview](docs/visual-qa/pos-preview).

The first comparison was made after the initial desktop pass; the mobile comparison was made after mobile home adjustments. The final pass made the mobile customer selection responsive, condensed selected customer context on the product screen, and increased quantity and add controls to at least 48 px. Final captures include `mobile-customers.png`, `mobile-catalog.png`, `mobile-cart.png`, `mobile-payment.png`, and `mobile-success.png`.

## Findings

| Area | Result | Difference from reference |
|---|---|---|
| Desktop shell and dashboard | Passed | Navy sidebar, white header, six KPI cards, action queue, seven-day chart area, operational summary, and recent activity match the visual hierarchy. The chart shows sample bars without the reference's overlaid line. |
| Desktop sales path | Passed | Customer picker, product search and category filtering, cart quantities, review, and success layout are present. Fewer sample rows and products are shown than in the reference. |
| Desktop secondary screens | Passed as visual layouts | Order list/detail, payment, and return screens are navigable. Their data and actions are examples, not a complete operational workflow. |
| Mobile sales path | Passed | Home shortcuts, customer cards, product list, cart, payment method, cash received, change, success, and bottom navigation follow the supplied ten-screen flow. |
| Safety and business facts | Passed | A visible preview notice labels all data as examples. Completing the sample flow does not create a payment, invoice, order, or document. The production POS API remains unconnected. |
| Responsive controls | Passed | The primary mobile actions and quantity/add controls meet the 48 px minimum touch target. |

The source images contain browser chrome, named brands, prices, business numbers, document statuses, and automatic posting implications. These are visual references, not approved business rules. This preview uses generated generic package images and example values, and it labels unverified checks and documents accordingly. The extra preview notice and selected customer context are deliberate UI differences.

## Interaction and technical checks

- Manual browser check at 1672 × 940: dashboard → customer selection → order entry → review → simulated success.
- Manual browser check at 390 × 844: home → customer selection → catalog → cart → payment; Rp 50.000 received against Rp 2.500 gives Rp 47.500 change → simulated success.
- Playwright: `pnpm --filter @pss/web exec playwright test -c playwright.e2e.config.ts tests/e2e/pos-preview.spec.ts` — 2 passed, including a customer needing review.
- `pnpm --filter @pss/web typecheck` — passed.
- `pnpm --filter @pss/web lint` — passed.
- `pnpm ui:check` — passed.
- `pnpm --filter @pss/web build` — passed. Existing middleware deprecation warning remains.
- Production server probe: `/pos-preview` returned 404; development server returned 200.

## Scope boundary

The user prioritized POS UI and UX. Backend POS authorization, inventory and price authority, taxes, credit checks, invoice generation, payment verification and allocation, return approval, and persistence require their own domain implementation and acceptance before any of these screens can become operational.
