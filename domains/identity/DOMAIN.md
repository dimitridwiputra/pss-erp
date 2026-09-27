# Identity domain

Status: IDN-001 account lookup and OIDC token boundary are partially implemented. User management, assignments, RBAC, MFA, and session lifecycle remain planned.

## Purpose

Map an IdP subject to one PSS user and keep PSS account status authoritative. The IdP verifies credentials; Identity determines whether that subject has an active PSS account.

## Owns

`identity.user_account` and its active/inactive state. The `idp_subject` has a unique constraint. Identity will own role assignments and session revocations when IDN-003 and IDN-001 are extended.

## Does not own

Passwords, IdP keys, business aggregates, or a role's operational facts. A valid IdP token does not grant a business permission.

## Commands

No production user mutation command exists yet. Test fixtures insert accounts directly into an isolated database. IDN-003 must provide audited create/deactivate/assign commands and IdP session revocation before account administration is enabled.

## Queries

`resolveActiveUser(pool, idpSubject)` reads the current PSS account on each request. An unknown subject returns `UNAUTHENTICATED`; an inactive account returns `ACCOUNT_INACTIVE`. The API `/me` endpoint composes this query with the `@pss/auth-client` JWKS verifier and returns a typed current-user response.

## Events produced and consumed

None yet. `USER_ACCESS_CHANGED` will be produced by role or status mutations and consumed by permission caches when IDN-003/RBAC-002 exist.

## Tables

Migration `0001_user_account.sql` creates `identity.user_account` with canonical user ID, organization ID, unique IdP subject, display name, optional employee/primary-branch references, status, version, and timestamps. No foreign key reaches another domain.

## Invariants

- One IdP subject maps to at most one PSS user.
- No active PSS account means no PSS session, even if the IdP token is valid.
- The account status check is uncached, so a database deactivation takes effect on the next request.
- Role and resource authorization are separate; `/me` grants no business action.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` error codes and response schema; `@pss/auth-client` for local JWKS signature and claims validation at the API edge.

## Open decisions and limits

IDN-001 is not complete: the local Keycloak container has no configured PSS realm or user; the web authorization-code/PKCE flow, refresh/logout, session revocation, mobile offline age, four-deployable JWKS enforcement, and three-environment IaC remain pending. OD-119/OD-120 still affect hosted IdP placement and configuration. No production account can be created through the app yet.

## Acceptance tests

`apps/api/tests/identity.integration.test.ts` uses a local JWKS server and an isolated PostgreSQL database to verify `/me` accepts an active mapped user, rejects missing/wrong-audience/unknown tokens, rejects an inactive PSS account, and denies an existing token on the first request after deactivation. `packages/auth-client/tests/access-token.test.ts` checks expiry, signature, audience, and missing-claim rejection.
