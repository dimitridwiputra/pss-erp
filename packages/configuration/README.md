# @pss/configuration

Typed, fail-safe configuration and OpenFeature flag evaluation for PLT-009/PLT-010.
Keys come from the generated PRD registry. Configuration values are effective-dated and
resolved with the Asia/Jakarta business date supplied by the caller. Empty values return
`UNSET`; a missing or failed flag evaluation is always `false`.
