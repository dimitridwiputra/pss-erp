# Identity domain

MVP-OD-10 (ADR-0015) adds the explicit permission `control_station.gross_profit_summary.view` in PRD Appendix D.2. CEO and COO receive ORGANIZATION scope; BRANCH_MANAGER receives BRANCH scope only. Sales Supervisor and other non-Finance operational roles receive no default grant. Identity returns scoped grants; Finance enforces the branch predicate on the server. This permission never implies GL or full P&L access. The Finance accountant `finance.journal.lines.view` grant follows the existing Appendix D.1 note.

Status: IDN-001 account lookup, OIDC token boundary, and local browser login are partially implemented. A read-only RBAC permission/scope foundation exists; user management, assignment commands, MFA, and session revocation remain planned.

## Purpose

Map an IdP subject to one PSS user and keep PSS account status authoritative. The IdP verifies credentials; Identity determines whether that subject has an active PSS account.

## Owns

`identity.user_account`, its active/inactive state, and `identity.role_assignment`. The `idp_subject` has a unique constraint. Identity will own audited assignment commands and session revocations when IDN-003 and IDN-001 are extended.

## Does not own

Passwords, IdP keys, business aggregates, or a role's operational facts. A valid IdP token does not grant a business permission.

## Commands

No production user or role mutation command exists yet. Test fixtures insert accounts and assignments directly into an isolated database. IDN-003 must provide audited create/deactivate/assign commands, SoD-07/08, and IdP session revocation before account administration is enabled.

## Queries

`resolveActiveUser(pool, idpSubject)` reads the current PSS account on each request. An unknown subject returns `UNAUTHENTICATED`; an inactive account returns `ACCOUNT_INACTIVE`. The API `/me` endpoint composes this query with the `@pss/auth-client` JWKS verifier and returns a typed current-user response.

- `scopeIdsFor(assignments, organizationId, permission, 'BRANCH' | 'WAREHOUSE')` turns a caller's assignments into the concrete branch or warehouse ids where the permission is held, or `all` for an organization-wide assignment. It applies the same role, permission and scope rules as `checkAccess`, so a list scoped by it in SQL never shows a row `checkAccess` would refuse on its own record.
- `getUserDisplayNames(executor, organizationId, ids)` names the people on a record. An id from another organization is simply absent.

`loadActiveRoleAssignments` reads only the user's effective, unrevoked assignments. `GET /me/permissions` returns concrete scoped grants after the same token and active-account check as `/me`. `checkAccess` denies by default, requires a declared role permission, checks role-compatible scope against canonical resource attributes, enforces organization isolation, and accepts a domain-owned state guard. A read outside scope yields `NOT_FOUND`; a mutation yields `PERMISSION_DENIED`.

## Events produced and consumed

None yet. `USER_ACCESS_CHANGED` will be produced by role or status mutations and consumed by permission caches when IDN-003/RBAC-002 exist. The current path queries assignments on every request and has no invalidation delay.

## Tables

Migration `0001_user_account.sql` creates `identity.user_account` with canonical user ID, organization ID, unique IdP subject, display name, optional employee/primary-branch references, status, version, and timestamps. No foreign key reaches another domain.

Migration `0002_role_assignment.sql` creates effective-dated, revocable role assignments with a single scope type and ID, uniqueness for unrevoked assignments, and a same-schema user FK. Roles are validated against the generated PRD Appendix D registry in the access policy; unknown role codes never grant access.

## Invariants

- One IdP subject maps to at most one PSS user.
- No active PSS account means no PSS session, even if the IdP token is valid.
- The account status check is uncached, so a database deactivation takes effect on the next request.
- Role and resource authorization are separate; `/me` grants no business action.
- A role cannot grant permission outside its declared scope type. `SYSTEM_ADMIN` has only explicit technical grants and no `payments.*`, `finance.journal.*`, or approval grant.
- Undefined Appendix D permission groups grant nothing; no wildcard is expanded at runtime.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` error codes and response schema; `@pss/auth-client` for local JWKS signature and claims validation at the API edge.

## Open decisions and limits

IDN-001 is not complete: the local Keycloak realm and synthetic account enable a browser authorization-code/PKCE flow and PSS account mapping. Auth.js stores access/refresh tokens in its encrypted HttpOnly cookie and refreshes access tokens. Local sign-out clears the web session; IdP-wide logout, admin session revocation, mobile offline age, four-deployable JWKS enforcement, and three-environment IaC remain pending. OD-119/OD-120 still affect hosted IdP placement and configuration. No production account can be created through the app yet.

RBAC-001/002 are not complete. Appendix D.1 refers to permission groups `FLT-EXCEPTION`, `APPROVE-ALL-L3`, `RPT-READ`, and `DWH-READ` without concrete permission expansion in D.2/D.3; the access policy grants none from these groups. `MDM-MANAGE` is given in D.2 only as the wildcard `master_data.*.manage`; it grants exactly `master_data.product.manage` (MVP-OD-25, demo default) and no other master-data resource. `POS-EXEC` and `POS-SUPERVISE` are transcribed from D.2. Two grants come from feature specs rather than a D.1 group and are listed with their citation in `role-permissions.ts`: `CSH-DECLARE` for `POS_CASHIER` (POS-014; the D.1 row omits it — MVP-OD-24) and `fulfillment.pickup.handover` for `WAREHOUSE_ADMIN`/`WAREHOUSE_OPERATOR` (Appendix D additions §46A, POS-010). Approval limits and SoD-07/08 require the approved assignment workflow. No business endpoint uses the policy yet, no scoped list-query predicate exists, and the client has no permission-aware navigation. These are release blockers, not implicit grants.

## Acceptance tests

`apps/api/tests/identity.integration.test.ts` uses a local JWKS server and an isolated PostgreSQL database to verify `/me` accepts an active mapped user, rejects missing/wrong-audience/unknown tokens, rejects an inactive PSS account, and denies an existing token on the first request after deactivation. `packages/auth-client/tests/access-token.test.ts` checks expiry, signature, audience, and missing-claim rejection.

`apps/web/tests/e2e/local-login.spec.ts` uses the synthetic local Keycloak account to verify unauthenticated redirect, successful login, scoped PSS Admin disclosure, local sign-out, and renewed protection of `/beranda`. A second test deactivates the PSS account and verifies the existing browser session loses access on its next page load, then restores the synthetic account.

`domains/identity/tests/demo-roles.test.ts` checks the MVP demo users in `infrastructure/keycloak/pss-demo-users.json` (MVP_PLAN §7): each is granted what the demo needs in the demo scope, denied other roles' actions and other scopes, and free of SOD-07/08.

`domains/identity/tests/access-policy.test.ts` covers default deny, role/scope/state evaluation, organization isolation, OWN scope, System Admin separation, and unresolved groups. `apps/api/tests/identity.integration.test.ts` also checks scoped grants are loaded from the Identity table and denied for inactive accounts. `tests/architecture.test.ts` checks direct role-name decisions fail the architecture fitness rule.
