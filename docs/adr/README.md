# ADR status

The authoritative ADR register is in [PRODUCT_PRD.md](../PRODUCT_PRD.md), Appendix K.
Its ADR-0001 through ADR-0011 entries are draft decisions awaiting Engineering sign-off
at F0. The register summaries alone do not supply the evidence a decision record needs;
each record must state context, alternatives, consequences, and fitness tests.

## Records written so far

| ADR | Subject | Status | Open decisions |
|---|---|---|---|
| [ADR-0009](ADR-0009-hosting-jakarta.md) | Hosting: Google Cloud, Jakarta region | Proposed | OD-119 answered (vendor + residency). OD-185, OD-188 remain open. |
| [ADR-0012](ADR-0012-infrastructure-as-code.md) | IaC tool: Terraform | Proposed | OD-187 answered. |
| [ADR-0013](ADR-0013-single-command-pipeline.md) | One command pipeline for every mutation | Accepted | No open decision. Deliberately leaves the stored idempotency response HTTP-shaped. |

ADR-0009 and ADR-0012 are **Proposed, not Accepted.** Neither has a human
signatory, and `docs/releases/F0.md` still records the accountable owner as
pending. ADR-0013 is Accepted on Engineering authority and carries no open
business decision — it constrains how a mutation is executed, not what it means.

## Still unwritten

ADR-0001 through ADR-0008 and ADR-0010 through ADR-0011 have register summaries but no
records. The register summaries are enough to know roughly what was decided; they are
not enough to review whether the alternatives were considered, and several carry
Sprint 0 decisions that are still open (OD-119, OD-120, OD-185, OD-187).

ADR-0010 (OIDC IdP, authorization in the identity domain) and ADR-0011 (OpenFeature
feature flags) both have live code and deserve records; ADR-0005 (canonical event
envelope) is effectively the foundation of the delivered outbox and inbox.
