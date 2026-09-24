# Event catalog

`catalog.json` is generated from PRD Appendix C. It lists 164 unique names: 125 base entries and 39 additions. Catalog presence does not make an event publishable. Only type/version pairs in `schemas.json` have a validated payload contract. Currently, that is `DELIVERY_ORDER_CLOSED` v1.

`schema-baseline.json` is the checked-in compatibility baseline. `pnpm contracts:check` rejects removal or breaking changes to a registered version; a new optional field is permitted. Review baseline updates against the previous main branch before merging. Event publication must call `parseEventForPublication`; an outbox integration is still planned for PLT-004.

Regenerate from source with `pnpm --filter @pss/contracts build`. Do not edit generated JSON by hand.
