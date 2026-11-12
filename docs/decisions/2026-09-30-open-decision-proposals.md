# Open business decisions — proposals and decisions

Date: 30 September 2026
Status: **Five accepted, one pending (GAP-16).** The accepted decisions are recorded in
[Accepted decisions](#accepted-decisions) at the end of this file; the proposals below are
retained as the reasoning behind them.

Six decisions from `docs/releases/F0.md` were open. Five are now answered by the repository
owner. The sixth, GAP-16 document numbering, is pending a template from the owner.

<a id="accepted-decisions"></a>

## Accepted decisions

### OD-19 — audit retention

**10 years total retention, 24 months hot in the primary database. ~820M audit rows must not
be kept in the primary database for 10 years.**

- Retention policy is configuration, not schema, so the period changes without a migration.
- Rows older than 24 months move to cold archive storage; they are not dropped. The 10-year
  obligation is met by the archive, not by the hot table.
- The monthly range-partitioned table becomes live and the swap is authorised. A partition is
  dropped only after its rows are archived and only when every row in it is past the period
  for its class — never on a clock alone.
- The unmeasured "~3 audit rows per mutation" assumption must be measured against real
  traffic, because it sets the archive volume and therefore the bill.

### Two consequences of this decision you should see

**1. A partition drop is the only way a row leaves `audit.audit_entry`.** The append-only
triggers forbid `DELETE`, so there is no way to trim a partition at 24 months without dropping
it. That follows from what was decided, and it is the correct behaviour for an audit trail. But
it makes the **archive receipt the only evidence that a row exists anywhere**. A silently-failing
archive client would let rows be released into nothing. The drop rule therefore requires a digest
match on every page rather than a row count alone, and the archive is a narrow interface with no
implementation yet — **no restore path has been exercised**, which is a production prerequisite
before the swap runs.

**2. The swap weakens the once-per-version guarantee from global to per-month.** PostgreSQL
requires the partition key in every unique constraint on a partitioned table, so the constraint
becomes `(occurred_at, request_id, entity_domain, entity_type, entity_id, entity_version)`.
Verified empirically against the partitioned table: the same `request_id` + entity + version
written in February and again in March is **accepted twice**.

This is a real change to an audit guarantee, not a cosmetic one — an auditor asking "how many times
was this entity version recorded?" can now get two answers. It is accepted here on the basis that
one request writes one entry per entity version inside one transaction, so the duplicate would
have to be a bug in the writer rather than a race. That reasoning is worth revisiting if audit
writing ever moves out of a single transaction.

The row `id` is also no longer globally unique (the primary key is `(occurred_at, id)`), but the id
is generated server-side by `randomUUID()` and is never caller-supplied, so the practical exposure
is nil.

### GAP-23 — status vocabulary

**Keep all 22 states in `pendingStatusLabels`.**

- When labels are written they are Indonesian and human-readable, per `docs/DESIGN_SYSTEM.md`.
- **`Menunggu persetujuan` is the generic label for any pending-approval state.**
- The `ui:check` guard stays as it is. The mechanism that makes a deliberate gap visible
  rather than silent is the point of `pendingStatusLabels`, so shrinking it to make the gate
  look better would be the wrong trade.

### Configuration-change approval

**Until a specific approval level is configured for a key, route to the highest approval
level. Do not auto-approve. Maker/requester ≠ approver remains mandatory.**

- This is the fail-safe direction and matches Appendix N's own note that
  `approval.<type>.levels` is KOSONG and therefore resolves to the highest level.
- Write permission and approval permission are separate. Holding one never implies the other.
- `identity.sod_exception` and `approval.<type>.levels` are themselves sensitive: a control
  that can rewrite who must approve it cannot be changed without approval.

### Branch business calendar and delivery promise

**Working week is Monday–Saturday. Sunday is a non-working day.**

- SLA computation uses `Asia/Jakarta` and the branch-specific calendar. The PRD already
  requires `platform.business_calendar` per branch.
- Official Indonesian national holidays are preloaded as non-working.
- Operations may override an individual branch as **OPEN** on a day PSS actually operates.
- **Cuti bersama follows the PSS annual operational calendar**, not an automatic closed rule.
- Exceptional branch closures and openings are allowed as dated overrides.
- **Normal delivery promise is H+1 operational working day from the order/fulfillment cut-off.**
- If delivery waits for route capacity, stock, or truck availability, the SLA is **not
  silently paused** — the operational delay and its reason are recorded.
- If the customer explicitly requests a later delivery date, that requested date is the
  delivery commitment.

### Configuration write permission

**The write path is supposed to exist. Fix the identity registry and register concrete
configuration-management permissions.**

- **SYSTEM_ADMIN may manage technical configuration.**
- **Business configuration may be proposed by the configured owner role for that key.**
- **SYSTEM_ADMIN does not receive general business-mutation authority.**
- **Sensitive configuration still goes through `config_change` approval. Write permission does
  not equal approval permission.**

This supersedes the earlier proposal to grant `configuration.*.manage` to SYSTEM_ADMIN. A
wildcard would have given a technical administrator blanket business reach, which is the
outcome SOD-07 exists to prevent. Two concrete permissions replace it, and the write path
resolves which one applies from the key's own classification.

---

# Proposals (superseded by the decisions above)

Retained for the reasoning and the measurements. The values in these sections are **not**
in effect where the accepted decisions differ.

Each proposal below states the value, the reasoning, what changes in code, and the options
with their cost. **A decision block is at the end of each section** for you to fill in.

Two proposals rest on a finding that is new since the register was written. See
[Finding: SOD is not wired to anything](#finding-sod-is-not-wired-to-anything) — it changes
what proposal 3 can honestly claim.

---

## 1. OD-19 — audit retention

### The shape of the question is wrong

OD-19 is written as one number. It should not be. `audit.audit_entry` currently carries
every audited event in one table — a posted journal, a cashier login, a customer address
change, and a failed scan all land in the same stream. Those have genuinely different
obligations, and a single period either over-retains cheap operational data or
under-retains a financial record.

The cost of getting it wrong is not symmetric. Too short and you cannot answer a tax
audit. Too long and you pay for 225,000 rows a day you will never read.

### Measured cost per year

From `infrastructure/terraform/README.md`, which derives these from the PRD's capacity
figures rather than from a guess:

| Measure | Value |
|---|---|
| Audit rows per day | ~225,000 (assumes ~3 audit rows per mutation, AGENTS.md §14) |
| Rows per year | ~82.1M |
| Bytes per row | ~700 B |
| **Storage per year** | **~57.5 GB** |

| Retention | Audit storage | Note |
|---|---|---|
| 1 year | ~57 GB | Enough for operational investigation only |
| 3 years | ~172 GB | Common security-log practice |
| 5 years | ~287 GB | The figure most often cited for Indonesian bookkeeping records |
| 7 years | ~402 GB | Conservative, covers most sector rules |
| 10 years | ~574 GB | Very conservative |

**One unmeasured assumption sits under all of these.** The ~3 rows per mutation figure is
an estimate, not a measurement. If the real multiplier is 6, every row above doubles. The
cheapest way to remove this uncertainty is to measure it against a week of production
traffic before committing to a period, and I would rather flag that than present a precise
table resting on an unverified constant.

### Recommendation — retention by class, not one number

| Class | What falls in it | Proposed | Reasoning |
|---|---|---|---|
| `FINANCIAL` | journal, invoice, payment, receipt, cash handover, period close/reopen, stock adjustment | **10 years** | These mirror the accounting subledger. The commonly cited floor for Indonesian commercial bookkeeping is 5 years; 10 is deliberately above it because the cost of being short is asymmetric and the growth assumption is unmeasured. |
| `BUSINESS` | order, inventory, customer, pricing, config and flag changes, master-data merges | **7 years** | Covers contractual limitation periods and most sector audit expectations with margin. |
| `SECURITY` | authentication, session lifecycle, permission and role changes, SOD decisions, denied access | **3 years** | Long enough to investigate an incident that surfaces late; shorter than the others because these rows are the highest volume and the lowest evidential value after a year. |
| `RAW_LANDING` | unmodified integration payloads | **180 days** | The PRD's own stated default for INT-003. Payloads are re-derivable from source and must not be mistaken for a business record. |

### What changes in code

- A `retention_class` column on `audit.audit_entry`, defaulting to `BUSINESS`, set by
  `appendAuditEntry` from the caller's declaration. `SEC-001` field classification already
  runs in CI, so the new field is classified rather than left unexamined.
- Retention policy as **configuration, not schema** — `audit.retention.<class>_days`. This
  is the important part: changing 7 years to 10 later is a config write, not a migration.
- The prepared monthly range-partitioned table
  (`0003_audit_entry_partitioning_prereq.sql`, already written and tested) becomes live, and
  the retention job drops a partition only when **every** row in it is older than its class
  period. No partition is ever dropped on a clock alone.
- Storage monitoring alert at 80% of provisioned capacity, because with a partitioned table
  the cost is bounded only if someone notices growth.

### Options

| | Option | Cost | Risk |
|---|---|---|---|
| **A** | **Class-based (recommended)** | ~574 GB worst case, ~500 GB typical | One migration and a new column. Slightly more to explain. |
| B | 7 years flat | ~402 GB | Over-retains security rows; under-retains financial if a sector rule needs 10 |
| C | 5 years flat | ~287 GB | Cheapest, and the most often quoted. Highest risk if a fiscal rule needs more, and a fiscal gap is the one failure that is not recoverable. |
| D | 3 years + archive cold rows to Cloud Storage | ~172 GB hot, archive pennies/GB | Cheapest to operate; adds a restore path you would have to test for real. |

### What I need from you

1. Confirm or change each class period.
2. **Whether counsel has a view** — I have deliberately not cited a specific statute as
   fact. The 5-year and 10-year figures above are industry practice for Indonesian
   bookkeeping, and the one that binds you is whichever sector rule your company falls under.
3. Whether the `FINANCIAL` class should be 10 or 7 years. I lean 10 and would rather
   over-retain one class than argue about it later.

> **Decision — OD-19:** retention class periods = __________. Counsel consulted: yes / no.
> Partition swap authorised: yes / no.

---

## 2. GAP-23 — the 22 unlabelled states

### These are not 22 copy problems

`packages/ui/src/status-vocabulary.ts` carries all 22 in `pendingStatusLabels`, each with a
reason. Reading them, they are **three different kinds of thing** that happen to be missing
a label, and the right answer is not the same for each. Treating this as "write 22 labels"
would produce 22 labels, most of which no user would ever see on a screen they use.

| Class | Count | What they are | Needs frontline copy? |
|---|---|---|---|
| **A — frontline document status** | 11 | States an operator sees on a task, discrepancy, exception, or tender | **Yes** |
| **B — sync result** | 4 | Outcome of an offline batch, not a document state | No — a result, not a status |
| **C — admin / master data** | 7 | Terminal, catalogue, and location states owned by administration | No — not a frontline surface |

### Class A — proposed labels (11)

Frontline register, short, per `docs/DESIGN_SYSTEM.md` §14.3. A frontline operator reads
these on a phone in a warehouse, so they are one or two words.

| State | Proposed label | Why this word |
|---|---|---|
| `PosTender.ACCEPTED` | **Diterima** | The tender was accepted. Appendix M has no row, but this state is genuinely operator-facing. |
| `WarehouseTask.CREATED` | **Menunggu** | Task exists, nobody assigned yet. "Belum diambil" would wrongly imply it is reserved. |
| `WarehouseTask.IN_PROGRESS` | **Dikerjakan** | Someone is on it. |
| `WarehouseTask.COMPLETED` | **Selesai, barang cukup** | **Deliberately parallel to the already-approved `COMPLETED_SHORT` label "Selesai, barang kurang".** A bare "Selesai" was my first draft and it was wrong: in a warehouse the difference between a full and a short pick is what triggers a variance report, and the approved register already uses the "barang kurang" form to signal it. Flattening `COMPLETED` to "Selesai" would have blurred exactly the distinction operators act on. |
| `WarehouseTask.CANCELLED` | **Dibatalkan** | Not an invention — `PosTender.VOIDED` is already approved with this word. Reusing approved copy keeps one register. |
| `StockDiscrepancy.REPORTED` | **Dilaporkan** | The operator has reported it; nothing decided yet. |
| `StockDiscrepancy.ADJUSTED` | **Disesuaikan** | Stock was corrected. |
| `StockDiscrepancy.REJECTED` | **Ditolak** | A supervisor refused it. |
| `ExceptionItem.OPEN` | **Terbuka** | Matches Appendix P's own queue vocabulary. |
| `ExceptionItem.IN_PROGRESS` | **Dikerjakan** | Someone is on it. |
| `ExceptionItem.RESOLVED` | **Selesai** | Queue closed. Distinct from `WarehouseTask.COMPLETED` on a different screen, so no ambiguity with the short-pick label arises here. |

### Class B — proposed treatment (4)

`PosOfflineBatch.APPLIED`, `PosOfflineBatch.APPLIED_WITH_CONFLICTS`, `WmsOfflineSync.APPLIED`,
`WmsOfflineSync.APPLIED_WITH_CONFLICTS`.

These are the **outcome of a batch**, not the status of a document. PLT-013 already restricts
the frontline sync surface to three statuses. My proposal is to label them as results —
**Tersinkron** and **Tersinkron Sebagian** — and to render them as a *result banner* on the
sync screen, never as a document status. That way an operator sees "some of your work needs
review" without the system pretending a batch is a document.

### Class C — proposed treatment (7)

`PosTerminal.ACTIVE/INACTIVE`, `KasirCatalogItem.DRAFT/ACTIVE/INACTIVE`,
`WarehouseLocation.ACTIVE/BLOCKED`.

These are administration and master-data states. **My recommendation is to leave them
pending**, deliberately, until an admin screen actually renders one. Inventing frontline
copy for a state no frontline screen shows produces vocabulary that has to be re-reviewed
when the admin screen is built.

Labels when needed, for the record: **Aktif / Nonaktif**, **Draf**, **Diblokir**.

### What changes in code

`pendingStatusLabels` shrinks from 22 to 11. `ui:check` continues to fail on a *new* state
with no label, so the guard is not weakened — it becomes accurate instead of suppressed.
The `pendingStatusLabels` mechanism stays either way, because it is what makes a deliberate
gap visible rather than silent.

One caution worth stating: these are labels I drafted against the design system, not copy
your operations team has validated with users. I would treat them as a strong default that
one person should sanity-check against how staff actually talk.

### Options

| | Option | Effect |
|---|---|---|
| **A** | **Class A now, B and C with the screen that needs them (recommended)** | 11 labels decided, 11 stay honestly pending |
| B | All 22 now | Frontline copy written for states no frontline screen shows; re-review when admin screens arrive |
| C | All 22 left pending | No progress; `ui:check` stays green but the vocabulary debt grows |

> **Decision — GAP-23:** approve Class A labels as written / amend them / other. Class B and
> C: label now or defer to the screen that needs them.

---

## 3. Configuration-change approval type

### The real blocker is not the missing type

`platform.approval_type` exists (migration `0003_approval.sql`) and is **empty**. The PRD
routes a *sensitive* config key to a `config_change` approval and a non-sensitive one
straight to `SCHEDULED`. Appendix N lists 39 keys but **never says which are sensitive** —
that column does not exist in the source.

So registering the approval type alone changes nothing. The missing piece is a sensitivity
rule. Registering a type and leaving sensitivity to the caller is what the code does today:
`proposeConfigValue` takes `requiresOwnerApproval` from the caller and refuses to honour it
without an approval id, so no value can move out of `PENDING_APPROVAL`.

### Proposed sensitivity rule

One rule, not 39 separate judgements — so it stays auditable and a new key inherits it:

> **A configuration key is SENSITIVE if changing it can change money owed, tax computed, or
> credit exposure. Everything else is routine and takes effect on schedule.**

Applying it to the **45** registered keys in Appendix N:

| | Keys | Count |
|---|---|---|
| **SENSITIVE — needs approval** | all `finance.*`, all `tax.*`, all `credit.*`, all `procurement.*`, all `invoicing.*`, `inventory.costing_method`, `inventory.valuation_unit`, `ar.aging_buckets`, `ar.overdue_tolerance_days`, `payments.cash_in_hand_max_hours`, `payments.bank_auto_match_rules`, `identity.sod_exception`, `approval.<type>.levels` | 25 |
| **ROUTINE — scheduled** | `orders.auto_confirm_external`, `orders.partial_confirmation`, `fulfillment.release_rule`, `fulfillment.cutoff_time`, `fulfillment.admin_confirm_requires_evidence`, `ar.collection_task_rule`, `ar.collection_task_expiry_days`, `returns.approval_rule`, `inventory.reservation_expiry_hours`, `inventory.transfer_approval_rule`, `sfa.geofence_radius_m`, `sfa.geofence_block`, `sfa.gps_accuracy_threshold_m`, `offline.max_age_hours`, `fleet.pod_policy`, `fleet.pod_missing_hours`, `integration.raw_retention_days`, `integration.retry_backoff_minutes`, `integration.parallel_run_tolerance`, `idempotency.retention_days` | 20 |

Three I want to flag rather than bury, because the rule does not settle them cleanly:

- `inventory.costing_method` and `valuation_unit` **change inventory valuation**, so they are
  SENSITIVE under the rule even though they read as inventory settings. Getting these wrong
  restates stock value silently.
- `approval.<type>.levels` sets **who must approve what**. If it can change without approval,
  the approval control can be edited by whoever is editing it, so it is SENSITIVE by
  necessity rather than by the money/tax/credit test. This one is a deliberate widening of
  the stated rule.
- `orders.auto_confirm_external` is the genuine judgement call. Auto-confirming externally
  originated orders changes what the company owes. I have placed it ROUTINE because it is an
  operational throughput setting with a credit check behind it, but I would accept SENSITIVE.
  `idempotency.retention_days` and `integration.raw_retention_days` are the same shape of
  question — shortening a retention window can destroy a replay or evidence path — and I have
  placed both ROUTINE because neither changes an amount owed. All three are one line each in
  the registry, so moving any of them is trivial.

### Proposed registration

```sql
-- Approval type
INSERT INTO platform.approval_type
  (code, owner_domain, subject_type, expiry_hours, delegation_allowed, reason_required)
VALUES
  ('config_change', 'platform', 'ConfigValue', 72, true, true);
```

| Field | Value | Why |
|---|---|---|
| `expiry_hours` | **72** | A config change left pending for three days is stale by the time it is decided. The caller re-proposes. |
| `delegation_allowed` | **true** | Otherwise one departing approver strands every sensitive config change. |
| `reason_required` | **true** | AGENTS.md §14 requires a reason code on this class of change. |

```sql
-- Level 1: Finance approves a sensitive key change.
-- Level 2: CFO approves the keys whose blast radius is an accounting or control failure.
INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code, max_amount)
VALUES
  (<policy>, 1, 'FINANCE_APPROVER', 'approval.config_change.decide', NULL),
  (<policy>, 2, 'CFO',            'approval.config_change.decide', NULL);
```

Level 2 is scoped to a **key subset** — `tax.*`, `finance.journal.emergency_self_approval`,
`identity.sod_exception`, `approval.<type>.levels` — because those four can disable a
control rather than merely mis-set a value. A single-level policy cannot express that.

### What changes in code

- A migration seeding `approval_type`, one `approval_policy`, and two `approval_level` rows.
- `sensitivity` added to the configuration registry as a per-key classification, so
  `proposeConfigValue` stops taking the caller's word for it. This is the part that actually
  unblocks PLT-009.
- **A prerequisite that is not a decision:** Appendix N's VAT row reaches the generated
  registry as one mangled expression, ``tax.vat_output_rate` / `tax.vat_input_rate``, so
  neither half is a registered key and both currently raise `CONFIG_KEY_UNKNOWN`. Classifying
  a key that does not parse is impossible, so the catalog generator has to split that cell
  first. It is a bug in `scripts/`, not a business question, and I will fix it as part of
  implementing this — but it means the 45 above will become 46 registered keys.
- `proposeConfigValue` routes on the registered classification: SENSITIVE opens an approval,
  ROUTINE goes to `SCHEDULED`. The current "refuses without an approval id" behaviour becomes
  a genuine check rather than a permanent refusal.
- Still **not** implemented, and worth naming: PLT-009.BR05 (reject a finance/tax key change
  dated into a `SOFT_CLOSE`/`CLOSED` period) needs a Finance-owned period check. AGENTS.md §3.1
  forbids Platform reading `finance`, so this is a synchronous Finance dependency or an
  event-driven guard — a Finance decision, not a Platform one.

<a id="finding-sod-is-not-wired-to-anything"></a>

### Finding: SOD is not wired to anything

While checking whether SOD-08 already makes maker ≠ approver structural, so that this
proposal would not have to build it, I found that it does not.

`checkSystemAdministratorSod`, `checkForbiddenRoleCombinations`, and `evaluateAssignmentSod`
are implemented in `domains/identity/src/domain/segregation-of-duties.ts`, exported from
`@pss/identity`, and covered by 15 passing unit tests. **They have no runtime caller.** The
only references anywhere in the repository are the module itself and its own test file.

Two consequences, both of which matter for this decision:

1. **SOD-07 and SOD-08 are not enforced** at role assignment or at approval time. A user can
   today be granted `SYSTEM_ADMIN` together with `CASHIER` and nothing rejects it. The rules
   are correct, documented, and inert.
2. **I cannot claim maker ≠ approver is already structural for config changes.** The only live
   control is `decideApproval`'s own check that `actorId !== requester_id` (approval.ts:117),
   which is real and sufficient for the *same user* case. But SOD-07's guarantee that a
   technical administrator never holds a business role is not running.

I would not want to record "SOD-08 makes this safe" in a decision document, because it is not
currently true. The fix is small — call `evaluateAssignmentSod` in the role-assignment write
path — and it belongs with this decision rather than after it, since this decision is what
first depends on it.

### Options

| | Option | Effect |
|---|---|---|
| **A** | **Register `config_change` + sensitivity rule + wire SOD into role assignment (recommended)** | Unblocks PLT-009 and makes two dormant controls live |
| B | Register the type and sensitivity rule only | PLT-009 unblocks; SOD stays inert and the gap stays undocumented in the code path |
| C | Keep deferring | Configuration stays frozen; every sensitive key waits on a process that does not exist |

> **Decision — approval type:** register `config_change` with the rule and level structure
> above: yes / no. SOD wiring included in this change: yes / no.
> **`orders.auto_confirm_external`:** SENSITIVE / ROUTINE.

---

## Not proposed here

| Decision | Why not |
|---|---|
| **GAP-16** — document numbering scheme | A fiscal document format. The pattern, branch code, gap policy, and padding are a Finance and Tax decision, and a plausible-looking format is worse than an explicit gap. The mechanism is complete and refuses to issue an unapproved number, which is the correct behaviour for an open decision. |
| **Branch business calendar** | Needs your actual branch list and operating calendar. Mon–Fri with no holidays is a registered default that is wrong the moment a public holiday lands in an SLA window. Data, not judgement. |
| **`configuration.*.manage` grant** | The obvious answer is SYSTEM_ADMIN, and it is also the wrong one on its own: SOD-07 says a technical administrator never holds a business mutation role, and the approval path needs a non-technical approver. Granting this without settling proposal 3 leaves every sensitive config change unapprovable. These two should be decided together. |

## A note on sequencing

If you take all three, this order is the one that compounds:

1. **`configuration.*.manage` + proposal 3 together** — the grant is useless alone, and
   proposal 3 needs a real maker to be exercised against.
2. **GAP-23 Class A** — unblocks frontline screens, which is the next UI work.
3. **OD-19** — independently, and on the longest fuse. Nothing is blocked by it today, and the
   partitioned table is already prepared, so it can follow without holding anything up.
