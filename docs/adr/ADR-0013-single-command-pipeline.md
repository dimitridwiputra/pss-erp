# ADR-0013 — One command pipeline for every mutation

Status: Accepted
Date: 30 September 2026
Deciders: Engineering owner (AI, delegated)
Supersedes: nothing. Depends on ADR-0005 (canonical event envelope) and PLT-002/PLT-006.

## Context

`AGENTS.md` §3.6 requires every command to be idempotent, §4.7 requires a posted
journal to balance, §14 requires a state mutation to leave an audit entry, and §18
forbids duplicate systems. Each of those is a property of *how* a mutation is
executed, not of any one domain's rules.

The repository already had the three ingredients:

- `withIdempotentCommand` held the idempotency row and took a **transaction runner**
  as a parameter;
- `withAuditedTransaction` / `runAuditedWork` guaranteed at least one audit entry
  before commit;
- `withConnection` ran a domain function in an audited transaction, reusing an
  open one when a caller already had it.

But nothing connected them, and the seams had already drifted:

**1. The audit guarantee was opt-in.** `withIdempotentCommand`'s third argument
selected the transaction runner. All four call sites passed
`async (client, work) => work(client)` — a pass-through. Nothing stopped a fifth
caller from passing a plain runner and committing a mutation with no audit entry,
and nothing stopped a caller from passing a runner that opened a *second*
transaction.

**2. `withConnection` had been copied three times.**
`domains/inventory`, `domains/wms`, and `domains/invoicing` each carried their own
`application/support/with-connection.ts`. The bodies were identical; the comments
had already diverged. Twelve domains still have no files, so a copy per domain was
the default outcome, not the exception.

**3. The document-numbering routes committed outside their idempotency row.**
`DocumentsController` passed only a `Pool` to `createNumberingScheme`,
`seedDraftNumberingSchemes`, and the reserve/confirm/void commands. Each opened its
own `withAuditedTransaction` on a second connection while the idempotency row sat
in the outer, uncommitted transaction. A failed outer commit left a mutation that a
retry would re-apply — burning document numbers and duplicating schemes. The
capability to share the transaction was already on those functions
(`transaction?: AuditedTransaction`); the routes simply did not use it, and
`createNumberingScheme` and `seedDraftNumberingSchemes` did not offer it at all.

**4. Four WMS commands were a documented exception.** `heartbeatOperatorSession`,
`assignException`, `resolveException`, and `syncOfflineConfirmations` ignored the
supplied client. The controller comment recorded this as accepted, on the reasoning
that PLT-006 replay semantics still applied. They were untested through HTTP, so
nothing would have noticed had they regressed.

**5. The audit counter was per-invocation, not per-transaction.** Fixing (1) exposed
this immediately. `runAuditedWork` counted entries in a local variable, so when a
domain function re-entered through `withConnection` on the same client, the inner
call took its own tally and the outer guard saw zero — rejecting a mutation that had
been audited. The obvious "fix" would have been to let those commands open their own
connections, which is exactly the atomicity loss in (3).

## Decision

**One exported path per concern, and a fitness gate that rejects the alternatives.**

1. **`runCommand(pool, key, execute)` is the only supported way to run a retriable
   mutation.** It opens the transaction, holds the idempotency row, and hands
   `execute` an `AuditedTransaction`. The transaction runner is **not** a parameter,
   so the audited path cannot be opted out of. `withIdempotentCommand` is no longer
   exported from `@pss/platform`.

2. **`withConnection(pool, transaction, work)` is solved once, in `@pss/platform`.**
   The three per-domain copies are deleted and their 15 call sites repointed.
   `inventory`, `wms`, and `invoicing` gain a `@pss/platform` dependency; there is no
   cycle, since `platform` depends only on `audit` and `contracts`.

3. **The audit count belongs to the transaction.** `runAuditedWork` keeps its tally
   in a `WeakMap` keyed by `PoolClient`. A client is checked out for exactly one
   transaction, so the entry is unreachable once the client is released and a
   rolled-back or committed transaction cannot leak a count into the next. Nested
   calls accumulate into the same tally, which is the intent of §14: the mutation is
   traced once, not once per wrapper.

4. **`runCommandWithoutAudit(pool, key, execute, reason)` exists for the two shapes
   that genuinely cannot share the caller's transaction** — a per-item-independent
   batch, and operational presence telemetry. The `reason` is a mandatory string
   literal of at least 20 characters, and every use is printed by the fitness gate
   so the list stays short and reviewable. The four WMS commands use it; a single
   business mutation has no reason to be there.

5. **`scripts/check-command-fitness.mjs` polices the plumbing, not just the routes.**
   Beyond the existing caller/body/idempotency-key rules it now rejects: importing
   `withIdempotentCommand` outside the canonical file, defining `withConnection` or
   `withIdempotentCommand` locally, and calling `runCommandWithoutAudit` without a
   readable literal justification. Every rule is exercised against a violating
   source in `tests/command-fitness.test.ts`, because a gate nobody has tried to
   violate is untested.

## Consequences

**Better**

- A mutation cannot commit without an audit entry, and a retry cannot double-apply.
  Both are now structural rather than conventions someone has to remember.
- The document-numbering routes share one commit with their idempotency row, closing
  a real double-apply path on reserve, confirm, void, and scheme creation.
- The audited-transaction helper has one definition instead of three, so the twelve
  remaining domains inherit it rather than reinvent it.
- The four WMS exceptions are enumerated with reasons in gate output, so a fifth
  shows up in a review diff rather than in a production log.

**Worse, and accepted**

- `runCommand` returns an HTTP-shaped `{ code, body }`, because the four existing
  callers store that in `platform.idempotency_key.response_body`. Decoupling the
  stored response from HTTP is a better model and is not done here: it would touch
  every command route for no behaviour change.
- A nested command that audits is now accepted by the outer guard, where previously
  each wrapper had to append its own entry. This is intentional — §14 requires the
  mutation to be traced, not each layer of plumbing — but it does mean an outer
  command can be satisfied entirely by an inner one.
- The fitness check walks the whole workspace on every run. It is fast enough now
  (a few hundred files), but it is not incremental.

**Not decided here**

- The stored idempotency response stays HTTP-shaped. Revisit if a non-HTTP caller
  (a worker replaying a queue, an integration adapter) needs the same envelope.
- `runCommandWithoutAudit` has no runtime counter or alert. It is reviewed by the
  gate; if the list grows past roughly a dozen entries, that is a signal the
  primitive is being misused and it should get stricter, not looser.

## Alternatives rejected

**Keep `withIdempotentCommand` and enforce the audited runner by convention.** A
convention across 14 domains and 12 more to come is exactly the drift already
observed in the four call sites. Rejected.

**Make the audit guard advisory — warn instead of throw.** Then a command that
forgets to audit ships silently, which is the failure mode §14 exists to prevent.
The guard firing on a nested command was a bug in the guard, not an argument for
weakening it. Rejected.

**Delete `runCommandWithoutAudit` and force the four WMS commands to share the
caller's transaction.** For `syncOfflineConfirmations` that would mean one rejected
scan rolls back an entire device queue, contradicting WMS-014.NC02's requirement
that a conflict surface as `NEEDS_REVIEW`. Rejected.

**Move the transaction and audit plumbing into `packages/`.** `AGENTS.md` §8 forbids
shared business logic in `packages/*`, and an audited transaction with an
enforced guarantee is domain policy, not a generic utility. It stays in
`domains/platform`, which already depends on `audit`.
