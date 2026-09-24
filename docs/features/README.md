# Feature directory source

`apps/web/data/features.generated.json` is generated from the 280 feature rows in `docs/IMPLEMENTATION_PLAN.md` Appendix A and their matching `FEATURE ID`, `PRIMARY USER`, and `USER OUTCOME` fields in `docs/PRODUCT_PRD.md`. It preserves the implementation plan's sprint and phase order.

`status.json` is a deliberately small, reviewed list of features with verified work. A feature absent from it is displayed as planned. `availablePath` is only used when a working page exists; partial backend or token work never creates a pretend ERP screen.

Run `node scripts/generate-feature-catalog.mjs` after approved source/status changes. `pnpm features:check` rejects a stale catalog. `/fitur` is a development-only, read-only directory; production builds do not expose the internal roadmap.
