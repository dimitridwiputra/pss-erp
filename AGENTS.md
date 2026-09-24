# AGENTS.md — PSS Operating Platform

Dokumen ini adalah instruksi wajib untuk semua Coding Agent, AI Agent, dan engineer manusia yang bekerja di repository PSS Operating Platform.

## 0. Mission

Bangun PSS Operating Platform sebagai sistem operasional dan finansial distribusi FMCG yang:

- sederhana bagi pengguna lapangan;
- akurat dan dapat diaudit;
- modular dan mudah dikembangkan;
- tidak mengunci PSS pada satu principal atau satu legacy system;
- dapat dikerjakan secara aman oleh manusia maupun AI;
- library-first;
- tidak menghasilkan spaghetti code, duplicate systems, atau speculative abstractions.

UI pengguna berbahasa Indonesia. Source code, identifiers, database objects, API contracts, dan event names menggunakan English.

---

## 1. Source-of-Truth Order

Sebelum melakukan perubahan, baca dokumen relevan dalam urutan berikut:

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/DESIGN_SYSTEM.md`
4. Parent PSS Operating Platform PRD
5. Domain PRD / `DOMAIN.md` terkait
6. ADR terkait
7. API/event contracts
8. Database schema/migrations
9. Existing tests
10. Existing implementation

Jika terjadi konflik:
- ADR yang lebih baru mengalahkan keputusan lama yang secara eksplisit disupersede.
- `ARCHITECTURE.md` mendefinisikan target greenfield architecture.
- Jangan “menyelesaikan” konflik dengan asumsi sendiri. Catat sebagai open decision.

---

## 2. Mandatory Workflow Before Editing

Untuk setiap task non-trivial:

1. **Inspect**
   - baca dokumen terkait;
   - cari implementation existing;
   - cari contract/event/schema existing;
   - cari test existing;
   - cari reusable library/component.

2. **State the plan**
   - domain owner;
   - files/modules yang berubah;
   - API/event/schema impact;
   - migration impact;
   - test yang diperlukan.

3. **Implement smallest coherent change**
   - hindari unrelated refactor;
   - jangan melakukan “cleanup” besar tanpa task eksplisit.

4. **Validate**
   - typecheck;
   - lint;
   - architecture check;
   - unit/integration/e2e test relevan;
   - migration check bila ada.

5. **Report**
   - apa yang berubah;
   - test yang dijalankan;
   - open decision/risiko yang masih ada;
   - dokumen/contract yang diperbarui.

---

## 3. Non-Negotiable Architecture Rules

### 3.1 Domain ownership is exclusive
Satu business fact memiliki satu owning domain.

Domain lain mengonsumsi melalui:
- public API;
- event;
- read model;
- replicated reference data yang eksplisit.

**Dilarang cross-domain direct database read/write.**

### 3.2 No principal-specific domain logic
Dilarang:

```ts
if (principal === 'NESTLE') { ... }
```

Gunakan `PrincipalSystemPolicy`, commercial configuration, atau integration adapter.

### 3.3 One canonical model
ND6, FoxPro, PSS SFA, manual import, dan DMS lain harus menghasilkan canonical objects yang sama.

Downstream domain tidak membaca source schema ND6/FoxPro secara langsung.

### 3.4 Authority is per fact
External system boleh authoritative untuk fakta tertentu dan PSS authoritative untuk fakta downstream lain.

Contoh: ND6 dapat memiliki fakta “ordered quantity/price”; PSS memiliki pick, delivery, invoice, collection sesuai policy.

### 3.5 Async by default across boundaries
State propagation lintas domain menggunakan event + transactional outbox.

Synchronous call hanya untuk keputusan yang diperlukan dalam request, misalnya:
- credit check;
- price;
- current availability;
- permission/policy decision.

### 3.6 Idempotent everything
- command lintas boundary memiliki idempotency key;
- event consumer dedupe berdasarkan eventId;
- import dedupe berdasarkan external key + payload hash;
- retry aman.

### 3.7 Nothing silently disappears
Malformed/unmapped/duplicate/failed records harus persisted dan terlihat di exception queue dengan owner/status.

### 3.8 Separate states
Jangan menggabungkan Order, Fulfillment, Shipment, Invoice, Receivable, Payment, Collection, Cash Custody, dan Journal menjadi satu status.

---

## 4. Finance Rules

PSS Finance adalah bounded domain yang terpisah dari operational ERP.

### 4.1 Authority
- Operational domain = source of truth untuk operational document/fact.
- Finance = source of truth untuk General Ledger dan accounting period.

### 4.2 Automatic posting
Operational economic events menghasilkan accounting posting melalui versioned posting rules.

### 4.3 Manual journal
Manual journal **diperbolehkan** untuk:
- accrual;
- depreciation;
- bank charge;
- tax adjustment;
- FX gain/loss;
- provision;
- audit adjustment;
- accounting correction;
- opening balance;
- transaksi yang tidak memiliki operational source document.

Manual journal tidak boleh mengubah operational state.

### 4.4 Posted journals immutable
Tidak boleh `UPDATE` jurnal yang sudah posted untuk mengubah economic meaning.
Correction menggunakan reversal + corrected journal.

### 4.5 Segregation of duties
Maker tidak boleh approve jurnalnya sendiri kecuali policy eksplisit memperbolehkan skenario emergency dengan audit trail khusus.

Collector tidak boleh menjadi pihak yang melakukan final payment application/settlement.

### 4.6 Period close
Closed accounting period tidak menerima normal posting.
Reopen memerlukan permission, reason, approval, audit event, lalu re-close.

### 4.7 Accounting equation
Setiap posted journal harus balance:

```text
SUM(debit) == SUM(credit)
```

Dalam tolerance currency yang didefinisikan.

---

## 5. UX Rules for Coding Agents

Baca `docs/DESIGN_SYSTEM.md` sebelum mengubah user-facing UI.

Wajib:
- copy Bahasa Indonesia;
- satu layar = satu pekerjaan;
- satu next action jelas;
- scan/pilih/foto > free text;
- raw enum tidak boleh terlihat;
- backend jargon tidak boleh terlihat;
- default yang aman dan relevan;
- mobile touch target ≥48 px;
- error actionable;
- loading/empty/error/offline state;
- permission-aware UI;
- progressive disclosure;
- jangan menampilkan data yang tidak dibutuhkan role.

Untuk WMS mobile: **SCAN → CONFIRM → NEXT**.

Untuk Driver mobile: maksimal 2 primary buttons per screen, one-handed, large type.

---

## 6. Library-First Policy

Sebelum membuat solusi custom, cari library/framework matang.

Approved baseline:
- Next.js / React;
- NestJS;
- Zod;
- Prisma;
- PostgreSQL / PostGIS;
- Redis / BullMQ;
- transactional outbox;
- NATS JetStream hanya saat extraction/volume membenarkan;
- S3-compatible storage;
- MapLibre;
- OpenStreetMap;
- Open Location Code;
- OSRM;
- VROOM;
- React Hook Form;
- TanStack Query/Table;
- Radix UI / shadcn/ui;
- Lucide;
- OpenTelemetry;
- Sentry;
- Playwright;
- Vitest/Jest.

Dilarang membuat custom:
- map renderer;
- spatial index;
- Plus Code algorithm;
- route optimization engine;
- auth protocol;
- barcode standard;
- message broker;
- form engine;
- table engine;
- chart engine;
- date/time library;
- money arithmetic primitive.

Dependency baru harus memiliki alasan jelas dan tidak menduplikasi library existing.

---

## 7. Repository Structure

Canonical target:

```text
pss-platform/
  AGENTS.md

  apps/
    web/
    api/
    finance-api/
    integration-worker/
    geo-service/
    driver-pwa/        # optional separate build when needed

  domains/
    identity/
    organization/
    master-data/
    principal-policy/
    commercial/
    orders/
    credit/
    fulfillment/
    inventory/
    invoicing/
    ar/
    payments/
    finance/
    sfa/
    wms/
    fleet/
    geo/
    integration/
    reporting/

  packages/
    contracts/
    ui/
    configuration/
    observability/
    auth-client/
    testing/

  docs/
    ARCHITECTURE.md
    DESIGN_SYSTEM.md
    adr/
    domains/
    api/
    events/
    runbooks/

  infrastructure/
```

Jangan membuat `utils/` sebagai tempat dumping business logic.

---

## 8. Domain Module Structure

Gunakan struktur predictable:

```text
domains/<domain>/
  README.md
  DOMAIN.md

  domain/
    entities/
    value-objects/
    rules/

  application/
    commands/
    queries/
    use-cases/

  infrastructure/
    database/
    events/
    external/

  interfaces/
    http/
    events/

  tests/
```

Business rules hanya berada di owning domain.

`packages/*` tidak boleh mengandung shared business logic.

---

## 9. API Rules

- REST + OpenAPI baseline.
- DTO/contracts menggunakan Zod canonical schema bila feasible.
- Endpoint user-facing berorientasi use case, bukan tabel database.
- Version breaking API secara eksplisit.
- Pagination wajib untuk list besar.
- Filter/sort allow-list; jangan menerima arbitrary SQL-like filter.
- Error response mempunyai stable code + human-safe message.
- Jangan expose internal stack trace.

Example error:

```json
{
  "code": "CREDIT_APPROVAL_REQUIRED",
  "message": "Pesanan perlu persetujuan karena batas kredit terlampaui.",
  "requestId": "..."
}
```

---

## 10. Event Rules

Event envelope canonical:

```ts
{
  eventId,
  eventType,
  eventVersion,
  occurredAt,
  organizationId,
  aggregateType,
  aggregateId,
  aggregateVersion,
  correlationId,
  causationId,
  payload
}
```

Naming:

```text
SALES_ORDER_CONFIRMED
FULFILLMENT_RELEASED
INVENTORY_ISSUED
DELIVERY_COMPLETED
INVOICE_ISSUED
PAYMENT_RECEIVED
PAYMENT_APPLIED
JOURNAL_POSTED
ACCOUNTING_PERIOD_CLOSED
```

Rules:
- event factual/past tense;
- schema versioned;
- additive changes keep version when backward-compatible;
- breaking change publishes v2 in parallel during migration;
- consumer must handle duplicate/replay.

---

## 11. Database Rules

### 11.1 Operational DB
Use PostgreSQL. Logical schemas by ownership:

```text
identity
core
sales
inventory
ar
payments
finance
integration
sfa
wms
fleet
geo
audit
reporting
```

Rules:
- UUID/ULID canonical IDs;
- external IDs stored through mapping/provenance structures;
- `created_at`, `updated_at`, actor/audit fields as appropriate;
- money uses decimal/numeric, never float;
- timestamps stored UTC, business date interpreted Asia/Jakarta;
- enum database only untuk vocabulary yang stabil; configurable business classification menggunakan reference table;
- migration forward-only;
- destructive migration requires explicit plan/backfill/rollback strategy;
- no domain writes another domain’s tables.

### 11.2 Data Warehouse
Maintain layers derived from Data Warehouse V2:

```text
raw
stg
dim
fact
mart
audit
```

Operational application must not read DW mart as transactional truth.

DW retains lineage/source payload references.

---

## 12. Integration Rules

External systems are adapters, not domain models.

Pipeline:

```text
raw landing
→ validation
→ normalization
→ mapping
→ deduplication
→ canonical command
→ reconciliation
```

Requirements:
- persist raw input before transformation;
- batch has ID/status/counts;
- malformed/unmapped/duplicate/failed rows visible;
- replayable;
- source provenance retained;
- no direct writing canonical DB via ad-hoc ETL SQL.

---

## 13. Offline Rules

SFA/Driver:
- local queue persists across restart;
- idempotency key generated client-side;
- optimistic UI only where business-safe;
- show simple sync state;
- user does not resolve technical conflicts manually unless required;
- server remains authority for credit/price/confirmation decisions.

WMS supports short outage queue for confirmations; allocation/final stock authority remains server-side unless explicitly designed otherwise.

---

## 14. Audit Rules

Audit is mandatory for:
- state mutation;
- approval;
- credit override;
- price override;
- stock adjustment;
- payment verification/application;
- cash handover;
- journal create/approve/post/reverse;
- period close/reopen;
- master merge;
- mapping override;
- role/permission change;
- integration credential change.

Audit must capture:
- actor;
- action;
- entity;
- before/after or material diff;
- timestamp;
- requestId/correlationId;
- reason code when applicable.

---

## 15. Security Rules

- least privilege;
- scoped RBAC;
- no secret in client bundle;
- no secret in logs;
- PII masked in logs;
- pre-signed object URLs;
- upload type/size/malware validation;
- server-side authorization on every protected mutation;
- system admin has technical permissions, not implicit business mutation permission;
- location collection follows minimum-required policy.

---

## 16. Testing Requirements

Minimum per change:

### Domain rule
Unit test.

### API/DB integration
Integration test.

### Event producer/consumer
Contract + idempotency/replay test.

### Critical UX
Playwright/e2e happy path + important exception path.

### Finance
Always test:
- journal balance;
- duplicate posting protection;
- reversal;
- period lock;
- approval separation;
- subledger ↔ GL reconciliation where relevant.

### Integration
Test:
- duplicate payload;
- malformed row;
- retry;
- worker killed mid-batch;
- replay.

---

## 17. Required CI Gates

Target commands:

```bash
pnpm lint
pnpm typecheck
pnpm architecture:check
pnpm contracts:check
pnpm db:check
pnpm test
pnpm test:integration
pnpm test:e2e
```

A PR may not merge if architecture/contract/migration gates fail.

---

## 18. Coding Quality Rules

Dilarang:
- dead code;
- commented-out implementation;
- duplicate domain entity;
- giant service classes;
- circular dependency;
- `any` tanpa alasan lokal yang terdokumentasi;
- magic strings untuk policy;
- hard-coded branch/principal/customer;
- arbitrary shared helper yang menyembunyikan ownership;
- business logic di controller/component;
- direct SQL di UI/BFF;
- silent catch;
- TODO tanpa issue/open-decision reference.

Prefer:
- small use cases;
- explicit names;
- pure domain rules;
- typed contracts;
- composition over inheritance;
- versioned policy/configuration;
- reversible migrations.

---

## 19. Documentation Requirements

Update docs saat:
- ownership berubah;
- API/event contract berubah;
- schema baru signifikan;
- ADR baru;
- operational runbook berubah;
- new permission/role;
- critical workflow berubah.

Setiap domain `DOMAIN.md` minimal berisi:
- purpose;
- owns;
- does not own;
- commands;
- queries;
- events produced/consumed;
- tables;
- invariants;
- dependencies;
- open decisions;
- acceptance tests.

---

## 20. Definition of Done

Task dianggap selesai hanya bila:
- behavior memenuhi PRD/ADR;
- domain ownership benar;
- no cross-domain DB dependency;
- contract typed/versioned;
- mutation audited bila relevan;
- idempotency/retry dipertimbangkan;
- tests hijau;
- UX mengikuti Design System bila user-facing;
- documentation updated;
- tidak ada open assumption tersembunyi.

Jika informasi bisnis belum tersedia, **stop and surface the open decision**. Jangan mengarang aturan bisnis.
