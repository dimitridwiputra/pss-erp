# Principal policy domain

Status: **partial PRI-004 domain rule**. Policy persistence, approval, activation, API, cache and exception handling are not implemented.

## Purpose

Own effective-dated authority decisions for a process and organization. The pure `resolvePolicy` rule implements PRI-004.BR01–BR02 against supplied approved policy history.

## Owns

Policy precedence and decision shape. The planned `PrincipalSystemPolicy` rows and approval lifecycle belong here under PRI-003.

## Does not own

Principal, branch, warehouse or transaction aggregates. Calling domains retain their own transactions and must record the returned `policyRowId` (PRI-004.BR03). The integration/platform exception queue will own `Q-POLICY_MISSING` persistence.

## Commands and queries

- Implemented query rule: `resolvePolicy(input, rows)`; `businessDate` is required and ISO-formatted.
- Planned: approved policy repository, `ResolvePolicy` application interface, batch API, and PRI-003 draft/submit/activate commands.

## Events produced and consumed

None in this slice. PRI-003 will produce `PRINCIPAL_SYSTEM_POLICY_ACTIVATED`; the future cache will consume it for invalidation.

## Tables

None in this slice. PRI-003 owns the future effective-dated policy table.

## Invariants

- Only `ACTIVE`, `SUPERSEDED`, or `EXPIRED` approved history can resolve. Superseded rows remain eligible for their historical effective dates.
- Date bounds are inclusive. The caller supplies the transaction business date; the rule never reads server time.
- General-process precedence is the six-tier PRD order. `INVENTORY`/`FULFILLMENT` use warehouse, branch, then DEFAULT, regardless of principal or stream.
- Equal-ranked eligible rows fail with `POLICY_OVERLAP`; no match fails with `POLICY_NOT_FOUND`. The rule never invents a fallback.
- Organization and process must match. The rule does not mutate supplied rows.

## Dependencies

`@pss/contracts` for registered domain errors and Zod for ISO-date validation. No direct cross-domain database access.

## Open decisions and remaining work

No policy values are seeded: OD-12 and related principal-specific decisions require owners. PRI-003 must validate scope shape, non-overlap, approval/SoD, effective dates, activation and immutable history before this rule is used for live commands. PRI-004 still requires a repository-backed interface, `Q-POLICY_MISSING` handoff, batch API, event-driven cache invalidation, benchmark and consuming-domain integration.

## Acceptance tests

`domains/principal-policy/tests/resolve-policy.test.ts` covers PRI-004.AC01, the date-selection rule of AC02, the warehouse-selection rule of AC03, the error half of AC04, and overlap/determinism. AC04's queue side and AC05 are outstanding.
