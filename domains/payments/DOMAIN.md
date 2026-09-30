# payments domain

Status: PAY-001/CSH-001 first real slice implemented — TUNAI (cash) recording and cash-custody verification only. This is intentionally narrow; see "Does not own" and "Open decisions" below before extending it.

## Purpose

Record tendered payments as PENDING_VERIFICATION facts and, for cash specifically, let a collector declare a cash handover (e.g. a POS shift close) and let Finance verify the physically counted amount against what was declared.

## Owns

`payments.payment` and `payments.cash_custody_record` (with its `payments.cash_custody_payment` links). This domain is the sole owner of the `payments` schema (enforced by `scripts/check-database.mjs`'s `schemaOwners`). Within this slice it owns:

- recording a payment attempt (`recordPayment`) as `PENDING_VERIFICATION`;
- declaring a TUNAI cash handover as one `cash_custody_record` linking the payments it collects (`declareCashHandover`);
- verifying that custody record against a physical count and cascading the outcome to its linked payments (`verifyCashCustody`).

## Does not own

- QRIS/TRANSFER/GIRO/CEK verification logic. The `payment.method` and `cash_custody_record.source` CHECK constraints allow these values for forward schema compatibility, but no command in this domain implements a verification path for anything but TUNAI (PAY-002/005/006/007/008 remain future work).
- Bank reconciliation (PAY-006/009).
- Payment application / AR allocation, e.g. `ApplyPayment` (PAY-003) or `TransferToCustomerCredit` (PAY-004). Nothing here touches `ar.*` or produces a `PAYMENT_APPLIED` event.
- Discrepancy resolution (CSH-002): a `DISCREPANCY` custody record has no command to move it to `RESOLVED` yet — see Open decisions.
- Any POS/SFA/FLEET domain logic (shift lifecycle, route, delivery, etc.) — those domains call into this one, never the reverse.

## Commands

- `recordPayment(pool, client, input)` inserts a `payments.payment` row with `status = 'PENDING_VERIFICATION'`, through `@pss/platform`'s `withConnection`. It joins the caller's open transaction when `client` is given; otherwise it opens its own. A POS cash payment (`channel: 'POS'`, `method: 'TUNAI'`) must carry `referenceType: 'POS_SALE'`, `customerId`, `cashLocation` (the shift) and `businessDate`. Those facts, and an optional `invoiceId`, are stored on the payment, and `PAYMENT_RECEIVED` v1 is published in the same transaction. Audited as `PAYMENT_RECEIVED`.
- `declareCashHandover(pool, client, input)` — sums the `amount` of the given `paymentIds` (SQL-side `SUM`), restricted to `method = 'TUNAI'` and `status = 'PENDING_VERIFICATION'`; throws `VALIDATION_FAILED` if any given id doesn't match that filter. Creates one `cash_custody_record` (`DECLARED`) plus one `cash_custody_payment` row per payment. Idempotent per the caller's exact `paymentIds`: if any of them is already linked to a `DECLARED`/`VERIFIED` record, returns that existing record instead of inserting a duplicate, and traces that no-op as `CASH_HANDOVER_DECLARE_NOOP` (ADR-0013 4b). A `POS_SHIFT` declaration names its shift in `sourceId`. Audited as `CASH_HANDED_OVER`.
- `verifyCashCustody(pool, client, input)` — loads the custody record `FOR UPDATE`; throws `CUSTODY_ALREADY_VERIFIED` if its status isn't `DECLARED`; throws `SEGREGATION_OF_DUTIES` (SOD-06) if `verifiedBy` is the record's collector. Computes `variance = countedAmount - declaredAmount` server-side (`numeric`, never a JS float). Outcomes:
  - A zero variance sets the record `VERIFIED` and cascades every linked payment to `VERIFIED`.
  - A non-zero variance with a registered `RC-CSH-*` `reasonCode` is also `VERIFIED`. The reason is stored and the variance is carried for posting (MVP-OD-9, demo default).
  - A non-zero variance without a reason sets `DISCREPANCY` and leaves linked payments untouched, for CSH-002.

  A `VERIFIED` `POS_SHIFT` record publishes `CASH_CUSTODY_VERIFIED` v1 in the same transaction, with the signed variance and the verification business date (Asia/Jakarta). Audited as `CASH_CUSTODY_VERIFIED` or `CASH_CUSTODY_DISCREPANCY_RECORDED`.

## Queries

None implemented. Reading a payment or custody record for a UI is deferred to the consuming domain's own read model / a future query in this domain.

## Events produced and consumed

Produced, through `appendOutboxEvent` in the same transaction as the fact (MVP_PLAN §5), each built from the stored row:
- `PAYMENT_RECEIVED` v1, for a POS TUNAI payment;
- `CASH_CUSTODY_VERIFIED` v1, for a verified POS-shift custody record.

Other channels and methods, `CASH_HANDED_OVER` and `CASH_CUSTODY_DISCREPANCY_RECORDED` have no v1 payload and are audited only. Nothing is consumed.

## Tables

Migration `0001_payments.sql`:

- `payments.payment` — one row per tendered payment. `amount` is `numeric(18,2) CHECK (amount > 0)`. `status` is one of `PENDING_VERIFICATION | VERIFIED | REJECTED | BOUNCED | REVERSED`, though only the `PENDING_VERIFICATION → VERIFIED` transition is implemented (the others are schema-reserved for future commands). `version` defaults to 1 and is incremented when `verifyCashCustody` cascades a status change.
- `payments.cash_custody_record` — one row per declared handover. `declared_amount` is computed at declaration time; `counted_amount` is filled in on verification. `status` is one of `DECLARED | VERIFIED | DISCREPANCY | RESOLVED`, but `RESOLVED` has no writer in this slice (see CSH-002 below).
- `payments.cash_custody_payment` — many-to-many link table (composite PK), one row per payment linked into a custody declaration.

## Invariants

- SOD-06: the user who verifies a cash custody record (`verifiedBy`) must never be the same user who declared it (`collectorId`). Enforced in `verifyCashCustody` before any mutation, raising `SEGREGATION_OF_DUTIES`.
- A payment can only ever be linked to one custody declaration. **Known limitation:** this is enforced only at the application level, inside `declareCashHandover`'s pre-insert join check (any `paymentIds` entry already linked to a `DECLARED`/`VERIFIED` record short-circuits to returning that existing record) — there is no database constraint (e.g. a unique index on `cash_custody_payment.payment_id`) preventing a payment from being linked to two custody records via a path other than `declareCashHandover` (e.g. a future bulk/admin tool). A future migration should add that unique index once the domain has more than one writer of `cash_custody_payment`.
- Only `TUNAI` payments in `PENDING_VERIFICATION` may be declared into a cash handover; `declareCashHandover` validates every given id against that filter before summing or inserting anything.
- A custody record can only be verified once: any status other than `DECLARED` at verification time raises `CUSTODY_ALREADY_VERIFIED` rather than re-processing it.
- Cascading a `VERIFIED` custody outcome to its linked payments and appending its audit entry happen inside the same transaction as the custody-record update — a crash between them is impossible, not just unlikely.

## Dependencies

PostgreSQL `pg`; `@pss/contracts` (`DomainError`, `MoneyAmountSchema`, registered error codes `VALIDATION_FAILED`, `NOT_FOUND`, `SEGREGATION_OF_DUTIES`, `CUSTODY_ALREADY_VERIFIED`); `@pss/audit` (`withAuditedTransaction`/`runAuditedWork`) for the mandatory audit trail on every mutation. No dependency on any other business domain; `domains/pos` (and, later, `domains/sfa`/`domains/fleet`) depend on this domain, never the reverse.

## Open decisions

- **OD-PAY-1 (event publication):** resolved for the POS cash path (see Events). Non-POS channels still publish nothing until their payloads are contracted.
- **MVP-OD-9 (variance at verification):** the demo default is described under `verifyCashCustody`. CSH-002's approval by `CSH-DISCREPANCY-APPROVE` is not built.
- **QRIS/TRANSFER/GIRO/CEK verification (PAY-002/005/006/007/008):** deferred. The schema accepts these `method`/`source` values so a payment can at least be *recorded*, but no verification command exists for them.
- **Bank reconciliation (PAY-006/009):** deferred entirely; no table or command in this domain addresses it.
- **Payment application / AR allocation (PAY-003 `ApplyPayment`, PAY-004 `TransferToCustomerCredit`):** deferred entirely; this domain never allocates a payment against an invoice or customer credit balance.
- **Discrepancy resolution (CSH-002):** a `DISCREPANCY` custody record has no `resolveCashDiscrepancy` command yet to move it to `RESOLVED` (e.g. after a supervisor accepts a shortage/overage). Its linked payments stay `PENDING_VERIFICATION` indefinitely until that command exists.
- **`recordPayment` has no idempotency key of its own.** It runs inside the caller's `runCommand` transaction: the POS tender route holds the `Idempotency-Key`, and a replay returns the stored response without calling it again. A direct caller outside that pipeline must not retry it.
- **Audit context.** All three commands accept an optional `requestId`/`correlationId` (and `branchId`) from the caller, and generate them only when absent. The actor is the id already in the input (`acceptedBy`/`collectorId`/`verifiedBy`).

## Acceptance tests

`domains/payments/tests/payments.integration.test.ts` — isolated PostgreSQL database applying this domain's `0001_payments.sql` and `@pss/audit`'s `0001_audit_entry.sql`. Covers: `recordPayment` creates a `PENDING_VERIFICATION` payment (and an audit entry); `declareCashHandover` sums only `TUNAI`/`PENDING_VERIFICATION` payments and links them, and a repeat call with the same `paymentIds` returns the same custody record rather than duplicating it; `verifyCashCustody` with a matching count marks `VERIFIED` and cascades to linked payments; with a mismatched count marks `DISCREPANCY` and leaves payments untouched; raises `SEGREGATION_OF_DUTIES` when `verifiedBy` is the collector; raises `CUSTODY_ALREADY_VERIFIED` on a second verify attempt.
