# PRD registries

`catalog.json` is generated from PRD Appendices D, F, M, N, and P. It retains the source wording for roles, permission groups, errors, reason codes, status labels, configuration, and exception queues. The matching typed catalog is in `@pss/contracts/registry`.

This is reference data, not an activated policy set. Entries marked `ASM` or `KOSONG`, wildcard keys, blank error copy, placeholder reason codes, composite role labels, and additional feature-spec entries need their named owner or later registry work before runtime use. In particular, the configuration defaults are not loaded into a live database by this generator.

Regenerate with `node scripts/generate-registry-catalog.mjs`; `pnpm contracts:check` detects drift from the copied PRD.
