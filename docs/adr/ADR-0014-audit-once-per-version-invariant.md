# ADR-0014 — Audit once-per-version is a transactional invariant, not a database constraint

Status: Accepted
Date: 30 September 2026
Deciders: Engineering owner, on an explicit product/architecture decision
Relates to: ADR-0013 (single command pipeline), AUD-001, DB.R09, PLT-000.R80, OD-19

## Context

`audit.audit_entry` was created unpartitioned with

```sql
CONSTRAINT audit_entry_once_per_version UNIQUE (request_id, entity_domain, entity_type, entity_id, entity_version)
```

which enforced "one audit entry per entity version" globally in the database.

OD-19 made `audit.audit_entry` a monthly range-partitioned table on `occurred_at`
(migration `0003`/`0006`). PostgreSQL requires the partition key to participate in
every unique constraint on a partitioned table, so the constraint became

```sql
UNIQUE (occurred_at, request_id, entity_domain, entity_type, entity_id, entity_version)
```

**Verified empirically, not inferred.** The same `request_id` + entity + `entity_version`
written in February and again in March is accepted twice.

**And the weakened constraint is worse than "partition-local": it is inert.**
`occurred_at` defaults to `now()` at microsecond precision, so two audit rows for one
entity version written milliseconds apart have *different* `occurred_at` values and the
constraint can never fire. Measured against the migrated table: two duplicates for the
same `(request_id, entity_id, entity_version)` in the **same month, same session** are
both accepted.

The practical consequence is that **after the swap the database provides no
once-per-version protection at all** — not globally, and not within a partition. The
transactional coupling and the optimistic entity version are not the primary guarantee
among several; they are the only guarantee.

The row `id` likewise stops being globally unique — the primary key is now
`(occurred_at, id)` — and the same reasoning applies, though it is doubly moot: the id is
generated server-side by `randomUUID()` and is never caller-supplied.

## Decision

**The global uniqueness loss is accepted. The once-per-version guarantee is enforced by
transactional coupling, and that is now stated rather than implied by a database
constraint that no longer provides it.**

Three parts:

1. **Transactional coupling is the guarantee, and after the swap it is the only one.**
   DB.R09 and AUD-001.R01 already require the audit write to land in the same transaction as
   the aggregate mutation and the outbox write. One request therefore writes one audit entry
   per entity version, and that is enforced by the commit boundary rather than by a check
   that fires after the fact — which matters more than usual here, because the database check
   no longer exists at all.

2. **Optimistic entity versioning stays part of the invariant.** DB.R07 gives every
   transactional aggregate a `version` column, and the audit row records the version it
   observed. The supported write path reads, checks, and increments that version inside the
   same transaction, so a second audit row for the same version cannot be produced by the
   supported path.

3. **The residual risk is named, not absorbed** — AUD-RISK-001, below.

## AUD-RISK-001 — Cross-partition duplicate audit identity

**Statement.** Two audit entries for the same `(request_id, entity_domain, entity_type,
entity_id, entity_version)` can coexist. After the partition swap the database will not stop
it at all, in the same month or across months.

**Why it is accepted now.** Reaching it requires a bug in a writer, not a race. Every
supported write path is one transaction containing the version check, the version
increment, the audit append, and the outbox insert. Two commits for one version means one of
those four steps is not in the transaction.

**Revisit this decision — evaluate a global idempotency table, or a different audit store —
if ANY of the following becomes true:**

- audit writing becomes asynchronous;
- audit writing moves outside the aggregate mutation transaction;
- audit moves to another database or service;
- external writers can write audit records;
- global audit identity becomes a regulatory requirement.

A global idempotency table is the natural first response: a separate **unpartitioned** table
holding `(request_id, entity_domain, entity_type, entity_id, entity_version)` with a unique
constraint, written in the same transaction. It is deliberately unpartitioned — a partitioned
one would reproduce the `occurred_at` defect above. It buys the database guarantee back at the
cost of one more row per audited mutation. That trade is not worth making until one of the five
conditions holds.

## What this ADR deliberately does not do

- It does not redesign the audit store. The decision is explicit: do not redesign solely to
  recover a global unique constraint right now.
- It does not claim the partitioned constraint provides global uniqueness. Anywhere the old
  constraint is described, the description now says partition-local.

## Consequences

**Better**

- The real guarantee is documented, including the part that is now weaker. A reader of
  `0006` or of `AUD-001` no longer has to rediscover this by reading PostgreSQL's
  partitioning rules.
- The invariant names where it lives: transaction boundary + optimistic version, both of
  which are testable without a partitioned table.
- AUD-RISK-001 carries five concrete revisit triggers rather than a general "revisit this".

**Worse, and accepted**

- A genuine writer bug that commits twice for one version is caught by nothing today. The
  database will not stop it, and no test asserts the absence of a duplicate across a real
  writer path — the closest is `audit-transaction.integration.test.ts`, which shows the
  transaction rolls back as a unit but not that a second append for one version is impossible.
  A duplicate remains *visible* to an auditor (two rows, same version, same request id), but
  nothing rejects it.
- A future reader comparing this against a system with a global constraint should read this
  ADR first. In particular, anyone who reads `UNIQUE (occurred_at, request_id, ...)` in
  `0003`/`0006` and concludes the table is protected is wrong, and that is why
  `audit-once-per-version.integration.test.ts` exists: it asserts the constraint is inert, so a
  future migration cannot reintroduce the assumption quietly.
