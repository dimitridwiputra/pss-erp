# Event catalog

`catalog.json` is generated from PRD Appendix C. It lists 175 unique names. Catalog presence does not make an event publishable. Only type/version pairs in `schemas.json` have a validated payload contract. The MVP §5 events remain at v1. ADR-0015 adds `FINANCE_APPROVAL_SUBMITTED` v1, `APPROVAL_REQUESTED` and `APPROVAL_DECIDED` v2 with subject version, `ACCOUNTING_PERIOD_REOPENED` v1, and `PAYMENT_REVERSED` v1 as a registered Payments compensation contract. The v1 approval contracts remain available for older consumers. Appendix C is the source for producer and aggregate; strict payload schemas are the wire contract.

`schema-baseline.json` is the checked-in compatibility baseline. `pnpm contracts:check` rejects removal or breaking changes to a registered version; a new optional field is permitted. Review baseline updates against the previous main branch before merging. Event publication must call `parseEventForPublication`; an outbox integration is still planned for PLT-004.

Regenerate from source with `pnpm --filter @pss/contracts build`. Do not edit generated JSON by hand.
