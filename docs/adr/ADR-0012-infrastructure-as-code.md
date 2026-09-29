# ADR-0012 — Infrastructure as Code with Terraform

- **Status:** Proposed
- **Decides:** OD-187 (IaC tool)
- **Relates to:** ADR-0009 (hosting), PLT-011, PLT-000.R91, PLT-012
- **Date:** 29 September 2026

## Context

PLT-000.R91 requires all infrastructure — network, database, cache, storage, runtime,
secrets, DNS, WAF, monitoring — to be defined as code in `infrastructure/`, with
changes arriving through a pull request. The problem being solved is stated in the
PRD: manually created environments are inconsistent and cannot be recovered.

The tool is a genuine choice rather than a formality, and it is coupled to ADR-0009:
a different cloud vendor would very likely imply a different tool.

## Decision

**Terraform**, with:

- Per-environment remote state in a GCS bucket, one prefix per environment
  (`pss/dev`, `pss/staging`, `pss/prod`).
- Plain HCL with no shared remote module registry, so the stack is reviewable in this
  repository and its history is the audit trail.
- Modules per concern: `network`, `database`, `cache`, `storage`, `secrets`,
  `services`, `governance`.
- A capacity-driven variable set per environment (`envs/*.tfvars`) rather than one
  configuration, so the sizing assumptions behind each environment are visible and
  reviewable side by side.

The PRD already anticipated this: PLT-011 names "OD-187 tool, misal Terraform/OpenTofu".

## Alternatives considered

### OpenTofu

A drop-in fork with an identical HCL dialect. The stronger defaults around state
locking and its open governance are genuine advantages. Rejected only because
Terraform has the broader provider ecosystem and the team already has the AWS/GCP
provider in use. If the licence posture of Terraform ever becomes a blocker, OpenTofu
is a near-zero-cost migration, since the dialect is the same.

### Pulumi

Real programming languages instead of HCL, with a genuine advantage for complex
logic. Rejected because it introduces a language runtime and its own CLI version
coupling into the delivery path, and because most of this configuration is declarative
resource graphs where HCL is not a limitation.

### Cloud-native tooling only — `gcloud` scripts, Cloud Build, Deployment Manager

Rejected outright. These either lack a declarative plan/diff, or lock the stack to a
single cloud in a way that contradicts ADR-0001's greenfield intent and would make a
future vendor change a rewrite rather than a migration.

### Manual console configuration

Not viable. It is the failure PLT-011 exists to prevent, and `PLT-011.AC02` requires
drift to be *detected*, which is impossible without a declared desired state.

## Consequences

**Accepted**

- Every environment is reproducible from a clean checkout.
- Drift is detectable with `terraform plan`, satisfying `PLT-011.AC02`.
- Sizing assumptions live in versioned `tfvars` files, not in a wiki.
- Region pinning is structural: a single `region` variable feeds every resource.

**Costs**

- Two bootstrap steps cannot be automated by this stack and are documented instead.
  The Google-managed provider exposes no resource for granting the Service Networking
  service agent its own role, and a state bucket cannot be created by the stack that
  stores its state in it. Both are in `infrastructure/terraform/README.md`.
- Terraform state is sensitive. It is excluded from git by `.gitignore`, and no
  credential is ever written into it: secret *names* live in Terraform, secret *values*
  are seeded out of band.

**Obligations**

- A change to machine tier or HA mode recreates a Cloud SQL instance.
  `prevent_destroy` is set so a routine `terraform apply` cannot take production down.
- Capacity is not static. `infrastructure/terraform/README.md` lists the triggers that
  force the arithmetic to be re-run, the first of which is measuring the real
  audit rows per mutation.

## Fitness tests

1. `terraform fmt -check -recursive` is clean.
2. `terraform validate` passes.
3. `terraform plan` succeeds for dev, staging, and production.
4. A fresh clone with a clean state bucket reproduces a staging environment with the
   same image digest that staging would have received (`PLT-011.AC04`).
5. No `.tfstate` file is ever committed; the secret scan is part of `pnpm lint`.
