# PSS Operating Platform — Greenfield Architecture 1.0

**Status:** Target architecture baseline  
**Tanggal baseline:** September 2026  
**Bahasa dokumen:** Bahasa Indonesia  
**Bahasa source code / schema / contracts:** English

Dokumen ini menerjemahkan PSS Operating Platform Architecture PRD 1.0, Business Overview, keputusan PSS Finance, Data Warehouse V2, serta PSS UX Constitution menjadi arsitektur greenfield yang dapat langsung digunakan engineer dan Coding Agent.

---

## 1. Tujuan Sistem

PSS Operating Platform adalah satu platform operasional dan finansial yang mengonsolidasikan transaksi dari PSS dan external principal systems tanpa memaksa seluruh principal menggunakan sistem PSS.

Prinsip bisnis:

> Setiap transaksi, dari sistem mana pun asalnya, menjadi canonical PSS record dengan provenance yang jelas.

PSS mengendalikan downstream operations sesuai authority policy:
- fulfillment;
- warehouse;
- delivery;
- invoice/AR;
- collection;
- finance;
- reporting.

ND6/FoxPro/future DMS diperlakukan sebagai integration source/authority sesuai kontrak, bukan model data internal.

---

## 2. Architecture Principles

### A-01 — Greenfield, domain-first
Repository baru dan schema baru dibangun dari target architecture; tidak membawa accidental coupling legacy.

### A-02 — Modular monolith by default, service extraction by evidence
Domain boundary dibuat keras sejak awal. Tidak semua bounded context harus menjadi proses terpisah pada hari pertama.

**Pengecualian yang disetujui:** Finance dapat dijalankan sebagai deployable terpisah sejak awal karena membutuhkan audit boundary, period locking, dan lifecycle yang berbeda, tetapi tetap berada dalam monorepo dan platform contract yang sama.

### A-03 — Library-first
PSS membangun business rules, workflows, adapters, orchestration, dan UX. Infrastruktur yang sudah solved menggunakan library/managed service.

### A-04 — One canonical model
Semua source menghasilkan canonical customer/product/order/invoice/payment/inventory references.

### A-05 — Principal System Policy is configuration
Authority, integration direction, process ownership, dan effective date adalah configuration data.

### A-06 — Authority per fact
Authority tidak diasumsikan per entity. Satu order dapat memiliki externally-authoritative fields dan PSS-owned downstream facts.

### A-07 — Exclusive ownership
Satu entity/fact ditulis oleh satu domain. Domain lain membaca melalui API/event/read model.

### A-08 — Async propagation
State propagation lintas domain melalui transactional outbox dan event. Synchronous call hanya untuk decision-in-request.

### A-09 — Idempotent boundaries
Command, event, import, dan callback lintas boundary harus retry-safe.

### A-10 — Nothing silently drops
Failure/unmapped/duplicate menjadi explicit records/queues.

### A-11 — Complexity stays behind the experience layer
UI tidak menampilkan topology service, state machine, atau raw backend vocabulary.

---

## 3. Target Context Map

```text
                               USERS
       Sales | Gudang | Driver | Admin | Finance | Management
                                 │
                                 ▼
                         EXPERIENCE LAYER
            Web / PWA / Role BFF / Control Station APIs
                                 │
      ┌──────────────────────────┼──────────────────────────┐
      │                          │                          │
      ▼                          ▼                          ▼
  CORE ERP                   PSS FINANCE                FIELD OPS
 commercial/O2C             accounting/GL          SFA / WMS / Fleet
      │                          │                          │
      └───────────────┬──────────┴───────────┬──────────────┘
                      │                      │
                      ▼                      ▼
                EVENT BACKBONE          SHARED GEO
                      │
          ┌───────────┼─────────────┐
          ▼           ▼             ▼
   Integration Hub  Reporting   Data Warehouse
   ND6/FoxPro/DMS   Read Models raw→stg→dim/fact→mart/audit
```

---

## 4. Bounded Domains

### 4.1 Core ERP
**Owns:**
- organization/branch commercial references;
- principal master;
- customer/outlet canonical master;
- product/SKU/UOM canonical master;
- supplier references;
- commercial rules/pricing;
- principal system policy;
- credit profile/decision;
- sales order;
- fulfillment request;
- commercial delivery document;
- invoice;
- AR subledger;
- payment and payment application;
- collection task;
- cash custody verification;
- financial inventory ledger;
- Control Station operational read models.

**Does not own:**
- physical warehouse bins/tasks;
- field visit telemetry;
- route execution/POD;
- canonical spatial dataset;
- General Ledger authority.

### 4.2 PSS Finance
Finance adalah accounting system of record.

**Owns:**
- chart of accounts;
- fiscal year/accounting period;
- journal/journal lines;
- posting rules;
- manual journal workflow;
- Finance approval subject state and business effects; `platform.approval` owns the shared approval mechanism and decisions (ADR-0015);
- GL;
- bank/cash accounting reconciliation;
- trial balance;
- P&L;
- Balance Sheet;
- Cash Flow;
- month-end close;
- close/reopen audit trail;
- audit adjustment.

**Rules:**
- operational events auto-post ke Finance;
- manual journal tidak mengubah operational state;
- posted journal immutable;
- correction = reversal + corrected journal;
- closed period locked;
- maker ≠ approver according to policy.

### 4.3 SFA
**Owns:**
- visit execution;
- check-in/out;
- prospect capture;
- field photos;
- SFA order request draft/submission;
- collection evidence;
- cash handover declaration;
- field route plan/visit sequence;
- offline queue/telemetry.

**Reads:** customer, product, price, credit result, AR summary, collection tasks from ERP; location from Geo.

### 4.4 WMS
**Owns:**
- warehouse zones/bins;
- physical stock location;
- allocation execution;
- pick/pack/stage/load tasks;
- receiving/putaway execution;
- count;
- warehouse unit/labels;
- adjustment request.

**Does not own:** financial valuation or final accounting inventory posting.

### 4.5 Fleet
**Owns:**
- vehicle operational master;
- driver assignment;
- delivery job execution copy;
- shipment;
- route plan/stops;
- dispatch;
- route execution;
- GPS during active route;
- POD;
- failure reason/evidence;
- fuel/route economics.

### 4.6 Geo
**Owns:**
- location + history;
- PostGIS point geometry;
- Plus Code derived representation;
- administrative polygons;
- territory geometries;
- geofence;
- spatial queries;
- completeness metrics.

### 4.7 Integration Hub
Anti-corruption layer untuk ND6/FoxPro/DMS lain.

**Owns:**
- connector configuration;
- raw landing;
- staging records;
- sync batches;
- external entity mapping;
- provenance;
- dedup/reconciliation result;
- outbound export job.

Tidak menulis canonical entities secara langsung kecuali melalui owning-domain command/API.

### 4.8 Reporting / Data Warehouse
Read-only analytical plane.

**Owns:**
- raw analytical landing;
- staging transforms;
- dimensions;
- facts;
- marts;
- audit/reconciliation datasets;
- BI semantic views.

Tidak boleh menjadi transactional source of truth untuk operational application.

---

## 5. Deployable Topology — v1

```text
apps/
  web/                  Next.js role-based web/PWA surfaces
  api/                  Core ERP + bounded modules not yet extracted
  finance-api/          Finance deployable
  integration-worker/   long-running imports/sync
  geo-service/          PostGIS API/service
```

WMS/SFA/Fleet dapat berada sebagai hard modules dalam `api` pada awal dan diekstrak jika extraction criteria terpenuhi.

### Extraction criteria
Extract domain menjadi proses/service terpisah bila minimal satu kondisi material terjadi:
- scaling/load profile berbeda signifikan;
- deployment cadence perlu independen;
- security/audit boundary memerlukan proses terpisah;
- availability/SLO berbeda;
- background workload mengganggu API;
- ownership team sudah terpisah;
- database isolation memberikan manfaat nyata;
- integration count/volume membenarkan operational overhead.

Jangan extract hanya karena “microservices lebih modern”.

---

## 6. Engineering Stack

### Language & monorepo
- TypeScript end-to-end.
- pnpm workspaces.
- Turborepo untuk task graph/cache.

### Web / PWA
- Next.js App Router.
- React.
- Tailwind CSS.
- Radix UI + shadcn/ui baseline.
- TanStack Query.
- React Hook Form + Zod.
- TanStack Table.
- Recharts.
- IndexedDB untuk offline queue/cache via library yang teruji.

### Backend
- NestJS.
- REST + OpenAPI.
- Zod contracts pada boundary.
- Prisma untuk transactional persistence.

### Data
- PostgreSQL operational.
- PostGIS untuk Geo.
- Redis untuk cache/lock/queue support.
- BullMQ untuk background job v1.
- Data Warehouse PostgreSQL-compatible layers untuk tahap awal; dapat diekstrak ke analytical engine bila volume membenarkan tanpa mengubah semantic model.

### Eventing
- Transactional outbox wajib.
- BullMQ/outbox dispatcher untuk v1.
- NATS JetStream saat multiple independent deployables/throughput/replay operationally membenarkan.

### Storage
- S3-compatible object storage.
- Evidence immutable/versioned according to policy.

### Mapping/Routing
- MapLibre.
- OpenStreetMap.
- Open Location Code.
- OSRM.
- VROOM bila routing optimization dibutuhkan.

### Observability
- structured JSON logging;
- correlation/request ID;
- OpenTelemetry;
- Sentry;
- health/readiness endpoints;
- business/integration metrics.

### Testing
- Vitest/Jest;
- Supertest/API integration;
- Playwright;
- contract tests;
- migration checks;
- architecture checks.

### CI/CD
- GitHub Actions;
- Docker;
- Infrastructure as Code;
- managed database/cache/storage preferred.

---

## 7. Experience Layer / BFF

Frontend tidak boleh mengorkestrasi banyak domain secara acak.

Gunakan role/use-case BFF/read APIs:

```text
GET /sales/today
GET /warehouse/next-task
GET /driver/today-route
GET /finance/close/current
GET /control-station/today
```

BFF boleh menggabungkan read model; tidak menjadi business-rule owner.

Tujuan:
- UI sederhana;
- fewer round-trips;
- backend state diterjemahkan ke user vocabulary;
- response khusus role;
- permission/filtering konsisten.

---

## 8. Operational Database Architecture

### 8.1 PostgreSQL logical ownership

```text
identity.*
core.*
sales.*
inventory.*
ar.*
payments.*
finance.*
integration.*
sfa.*
wms.*
fleet.*
geo.*
audit.*
reporting.*
```

Satu cluster diperbolehkan pada tahap awal untuk operasi sederhana, tetapi setiap schema memiliki owning module dan DB role boundary yang dapat diperketat bertahap.

### 8.2 Key database rules
- canonical ID = UUID/ULID;
- external ID tidak digunakan sebagai PK internal;
- numeric/decimal untuk money/cost;
- append-only ledger/movement untuk economic/audit history;
- effective-dated policy/configuration;
- no cross-domain mutation;
- DB FK lintas domain dihindari; gunakan ID reference + application-level contract bila domain separation diperlukan;
- forward-only migrations;
- audit write transactionally coupled dengan mutation bila relevan.

---

## 9. Data Warehouse Architecture — V3

Data Warehouse V2 menjadi baseline semantic model.

Layers dipertahankan:

```text
raw
 ↓
stg
 ↓
dim + fact
 ↓
mart
 ↓
BI / Control Station analytical views

parallel:
audit
```

### 9.1 Existing concepts retained
- sales facts;
- AR invoice/payment;
- inventory movement;
- costed inventory movement;
- warehouse movement;
- stock card;
- AR status/aging;
- monthly inventory valuation;
- reconciliation/audit datasets.

### 9.2 Dimensions diperluas
Target dimensions:

```text
dim.organization
dim.branch
dim.principal
dim.customer
dim.outlet
dim.product
dim.product_uom
dim.warehouse
dim.salesperson
dim.channel
dim.subchannel
dim.area
dim.territory
dim.revenue_stream
dim.source_system
dim.source_application
dim.order_source
dim.account
dim.cost_center
dim.date
```

### 9.3 Finance facts/marts
Tambah:

```text
fact.gl_entry
fact.account_balance
fact.bank_transaction
fact.cash_movement

mart.trial_balance
mart.profit_loss
mart.balance_sheet
mart.cash_flow
mart.profit_loss_branch
mart.profit_loss_principal
mart.profit_loss_revenue_stream

audit.gl_balance_check
audit.gl_subledger_reconciliation
audit.ar_gl_reconciliation
audit.inventory_gl_reconciliation
audit.bank_reconciliation
```

---

## 10. Canonical Domain Model — Minimum

```text
Organization
Branch
Principal
Customer
Outlet
Product
SKU/UOM
Warehouse
Salesperson

SalesOrder
SalesOrderLine
FulfillmentRequest
DeliveryOrder
Shipment
Invoice
Receivable
Payment
PaymentApplication
CollectionTask
CashCustodyRecord

InventoryMovement
PhysicalInventory

Journal
JournalLine
AccountingPeriod

Location
ExternalEntityMapping
PrincipalSystemPolicy
```

Jangan menggabungkan lifecycle hanya untuk mengurangi jumlah tabel/entity.

---

## 11. Integration Architecture

```text
External source
   │
   ▼
Raw Landing (immutable)
   │
   ▼
Validation
   ├── invalid → Exception Queue
   ▼
Normalization
   │
   ▼
External ID Mapping
   ├── unmatched → Mapping Queue
   ▼
Deduplication
   ├── suspicious → Review Queue
   ▼
Canonical Command
   │
   ▼
Owning Domain
   │
   ▼
Reconciliation
```

Connector transport dapat berupa:
- API;
- scheduled file;
- SFTP;
- DBF/export;
- CSV/XLSX manual upload;
- webhook.

Transport tidak mengubah canonical contract.

---

## 12. Event Backbone

Canonical envelope:

```text
eventId
eventType
eventVersion
occurredAt
organizationId
aggregateType
aggregateId
aggregateVersion
correlationId
causationId
payload
```

Key events:

```text
CUSTOMER_CREATED
CUSTOMER_UPDATED
SALES_ORDER_CONFIRMED
FULFILLMENT_RELEASED
PICK_COMPLETED
SHIPMENT_DISPATCHED
DELIVERY_COMPLETED
INVOICE_ISSUED
PAYMENT_RECEIVED
PAYMENT_APPLIED
CASH_HANDED_OVER
INVENTORY_ISSUED
INVENTORY_ADJUSTED
JOURNAL_POSTED
ACCOUNTING_PERIOD_CLOSED
```

Every consumer maintains inbox/dedup state.

---

## 13. Finance Architecture

### 13.1 Posting flow

```text
Operational event
      │
      ▼
Finance Event Consumer
      │
      ▼
Posting Rule Resolver
      │
      ▼
Draft/System Journal
      │
      ▼
Validation
(debit = credit, period open, accounts active)
      │
      ▼
POSTED GL
```

### 13.2 Example
Invoice issued:

```text
Dr Accounts Receivable
Cr Sales Revenue
```

COGS recognition according to approved recognition point:

```text
Dr Cost of Goods Sold
Cr Inventory
```

Customer payment applied:

```text
Dr Bank / Cash
Cr Accounts Receivable
```

### 13.3 Manual journal

```text
Draft
 → Submit
 → Review
 → Approve
 → Post
```

Posted records immutable.

### 13.4 Financial dimensions
Jangan membuat COA terpisah untuk setiap branch/principal.

Gunakan dimensions:
- branch;
- principal;
- revenue stream;
- cost center;
- customer/vendor bila relevan.

### 13.5 Month-end close
Status:

```text
OPEN → SOFT_CLOSE → CLOSED
```

Reopen = privileged workflow + reason + approval + audit.

Close checklist mencakup minimal:
- sales/invoice cutoff;
- AR reconciliation;
- inventory reconciliation;
- bank reconciliation;
- AP bila sudah aktif;
- accrual/prepayment;
- depreciation;
- tax adjustments;
- trial balance review;
- management approval.

---

## 14. Inventory Architecture

Tiga konsep tidak boleh dicampur:

```text
WMS Physical Stock
       │
       ▼
ERP Financial Inventory Ledger
       │
       ▼
Finance GL Inventory Value
```

Reconciliation harus memungkinkan:

```text
physical qty ↔ inventory ledger ↔ GL value
```

Canonical movement vocabulary mempertahankan kebutuhan Data Warehouse V2, termasuk purchase, sales, return, transfer, canvas movement, stock opname, dan adjustment.

---

## 15. Offline Architecture

### SFA / Driver
- scoped master/read data cached;
- drafts + actions persistent locally;
- queue survives restart;
- client idempotency keys;
- retry with backoff;
- photos queued separately;
- sync status visible sederhana;
- credit/order final confirmation server-authoritative.

### WMS
- short-outage confirmation queue;
- no uncontrolled offline allocation;
- paper fallback/runbook for extended outage.

---

## 16. Security & RBAC

Scopes:

```text
ORGANIZATION
BRANCH
WAREHOUSE
TERRITORY
PRINCIPAL
CUSTOMER
SALES_TEAM
```

Representative roles:
- SALES_REP;
- SALES_SUPERVISOR;
- SALES_ADMIN;
- BRANCH_MANAGER;
- WAREHOUSE_OPERATOR;
- WAREHOUSE_ADMIN;
- DRIVER;
- DISPATCHER;
- FLEET_ADMIN;
- CASHIER;
- AR_OFFICER;
- FINANCE_MAKER;
- FINANCE_APPROVER;
- MASTER_DATA_STEWARD;
- INTEGRATION_OPERATOR;
- GIS_ADMIN;
- MANAGEMENT;
- INTERNAL_AUDIT;
- DATA_ANALYST;
- SYSTEM_ADMIN.

UI permission bukan security boundary. Authorization tetap server-side.

---

## 17. Observability

Setiap request/event/job harus dapat ditelusuri melalui:
- requestId;
- correlationId;
- eventId;
- batchId bila integration;
- actor/user;
- organization/branch scope.

Dashboard engineering minimal:
- API error rate/latency;
- worker queue depth;
- integration batch status;
- DLQ age;
- event consumer lag;
- database connections/slow queries;
- offline sync failure;
- finance posting failure;
- reconciliation exceptions.

---

## 18. Scalability Targets

Architecture harus dapat berkembang tanpa redesign fundamental menuju:
- ±20 branches;
- ±30 principals;
- 150k outlets;
- 50k order lines/day;
- ±500 concurrent mobile users.

Scale strategy:
1. stateless API horizontal scale;
2. worker concurrency/partitioning;
3. read models/cache;
4. database indexing/partitioning bila dibutuhkan;
5. extract bounded domain yang memiliki load pattern berbeda;
6. event backbone dedicated saat justified;
7. analytical workload dipindahkan dari operational DB.

Jangan memulai dengan Kubernetes kecuali operational need nyata.

---

## 19. Repository Architecture

```text
pss-platform/
  AGENTS.md

  apps/
    web/
    api/
    finance-api/
    integration-worker/
    geo-service/

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
    auth-client/
    configuration/
    observability/
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
    docker/
    database/
    deployment/
    monitoring/
```

---

## 20. Architecture Fitness Functions

CI harus dapat menolak pelanggaran berikut:
- cross-domain import yang tidak diizinkan;
- direct database access ke schema domain lain;
- event yang tidak terdaftar di contracts;
- undocumented migration;
- UI raw enum leakage;
- duplicated component/system;
- principal/branch hard-code;
- mutation tanpa audit requirement;
- finance posting tanpa idempotency;
- unmatched event schema version.

Target scripts:

```text
architecture:check
contracts:check
db:check
ui:check
```

---

## 21. Superseding Finance Decision

Keputusan lama “operational documents are economic truth; GL derivative; no manual journal UI” diperbarui untuk target greenfield menjadi:

> Operational documents tetap authoritative untuk operational economic events. PSS Finance authoritative untuk General Ledger. Operational events menghasilkan journal otomatis. Manual journal diperbolehkan hanya untuk accounting events/adjustments yang tidak boleh memutasi operational state. Posted journal immutable; correction melalui reversal; closed period locked dan reopen diaudit.

Keputusan ini harus dicatat sebagai ADR Finance tersendiri pada repository final.

---

## 22. Definition of Done — Architecture

Release/domain belum dianggap selesai bila:
- ownership tidak jelas;
- canonical contract belum typed;
- source provenance hilang;
- failure dapat silent-drop;
- retry menimbulkan duplicate economic event;
- role/permission tidak jelas;
- audit trail tidak tersedia;
- user workflow membocorkan complexity backend;
- analytical reporting bergantung pada ad-hoc operational SQL;
- Finance tidak dapat merekonsiliasi subledger ↔ GL;
- migration/runbook/backup belum diperbarui.

---

## 23. North Star

Arsitektur PSS harus menghasilkan dua hal sekaligus:

1. **Enterprise-grade internals:** canonical data, strong ownership, event-driven propagation, auditability, financial control, GIS, offline capability, warehouse execution, integration resilience, dan analytical lineage.
2. **Consumer-grade simplicity:** pengguna lapangan hanya melihat pekerjaan berikutnya dan informasi minimum yang dibutuhkan untuk menyelesaikannya.

Kompleksitas adalah tanggung jawab platform, bukan pengguna.
