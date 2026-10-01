# Migration plan: 0008 audit partition drop role separation

Applies to `domains/audit/infrastructure/database/migrations/0008_audit_partition_drop_role_separation.sql`

Flagged as destructive by PLT-002.AC02 because the file contains `DROP TABLE` inside a `plpgsql`
function body. It is **not** executed at migration time. The string exists because the file
redefines `audit.drop_month_partition`, and its body has to keep the same `DROP TABLE` it always had.

## Why it is still reviewed as destructive

A checker matching on `DROP TABLE` should not be taught to look inside a function body, because that
is the wrong trade: the rule is cheap, and a false negative here means a migration that can destroy
audit evidence reviewed as if it were routine. The sibling plan exists so a human reads it anyway.

## Backfill

None. No data is read, written, or transformed. The migration creates two group roles if they are
absent and changes grants.

One behavioural change is not a data change but needs stating: `audit.drop_month_partition` becomes
`SECURITY DEFINER`. Before this, the function ran as its caller, so the DROP required the caller to
own the audit tables — which in practice meant the migration role, which an application connection
using migration credentials also is. After this, the DROP runs as the function's owner and authority
becomes a grant that can be withheld. Existing callers that were relying on ownership rather than on
`GRANT EXECUTE` will now need membership of `pss_maintenance`.

## Compatibility

Rolling out alongside a running system is safe in both directions.

- **New deployment, same role.** If the application continues to connect as the migration role, it
  owns the tables and `SECURITY DEFINER` changes nothing for it. The gate is still bypassable by
  that connection until it connects as `pss_app` instead — which is the deployment change that
  actually delivers the invariant, and it is a Terraform/secret change, not a migration.
- **Old code, new database.** No code depends on the function's privileges. The retention job calls
  the same function; it only needs `pss_maintenance`.
- **Role membership.** `pss_app` and `pss_maintenance` are `NOLOGIN` group roles. Deployments that
  have not yet created login roles to receive them are unaffected — nothing is revoked from a role
  that does not exist. `REVOKE ... FROM PUBLIC` does apply immediately, but as `SECURITY INVOKER`
  already refused non-owners, no working caller loses access.

## Rollback

Rolling back is `DROP ROLE pss_app; DROP ROLE pss_maintenance;` after revoking the grants, plus
restoring `SECURITY INVOKER` on the function:

```sql
REVOKE ALL ON FUNCTION audit.drop_month_partition(text) FROM pss_maintenance;
-- recreate the function without SECURITY DEFINER, per migration 0005
DROP ROLE IF EXISTS pss_app;
DROP ROLE IF EXISTS pss_maintenance;
```

`DROP ROLE` fails while privileges or memberships remain, which is the database's own guard against
removing a role still in use. Resolve those first rather than forcing it.

Rolling back restores the exposure described in the migration's comment: any connection owning the
audit tables can drop a partition without archiving or verifying it. That is the state the system was
in before, not a state to return to deliberately.
