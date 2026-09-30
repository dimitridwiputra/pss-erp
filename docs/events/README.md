# Event catalog

`catalog.json` is generated from PRD Appendix C. It lists 174 unique names. Catalog presence does not make an event publishable. Only type/version pairs in `schemas.json` have a validated payload contract. Currently those are, all at v1: `DELIVERY_ORDER_CLOSED`, `DELIVERY_ORDER_DELIVERED`, `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`, and the MVP set from `docs/mvp/MVP_PLAN.md` §5 — `INVENTORY_RECEIVED`, `INVENTORY_ISSUED`, `INVENTORY_ADJUSTED`, `INVOICE_ISSUED`, `PAYMENT_RECEIVED`, `CASH_CUSTODY_VERIFIED`, `JOURNAL_POSTED`, `JOURNAL_REVERSED`, `ACCOUNTING_PERIOD_CLOSED`. The MVP payloads follow §5 rather than the Appendix C payload-key column, which predates them; Appendix C remains the source for producer and aggregate.

`schema-baseline.json` is the checked-in compatibility baseline. `pnpm contracts:check` rejects removal or breaking changes to a registered version; a new optional field is permitted. Review baseline updates against the previous main branch before merging. Event publication must call `parseEventForPublication`; an outbox integration is still planned for PLT-004.

Regenerate from source with `pnpm --filter @pss/contracts build`. Do not edit generated JSON by hand.
