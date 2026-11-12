# MVP demo accounting defaults

Status: **DEMO DEFAULT — pending Finance sign-off**. These values support the synthetic PSS Kasir demonstration only. They do not authorize live books, real cash, or production tax treatment. Source: [MVP plan §8](../mvp/MVP_PLAN.md#8-demo-default-accounting-policy-codex-records-it-as-a-decision-finance-must-sign-off).

## Chart of accounts (MVP-OD-1)

All amounts are IDR. The demo has one organization and one branch.

| Code | Account | Type | Normal balance |
|---|---|---|---|
| 1-1100 | Kas Kantor | Asset | Debit |
| 1-1110 | Kas Konter | Asset | Debit |
| 1-1300 | Piutang Usaha | Asset | Debit |
| 1-1400 | Persediaan Barang Dagang | Asset | Debit |
| 2-1150 | Barang Diterima Belum Ditagih | Liability | Credit |
| 2-1300 | PPN Keluaran | Liability | Credit |
| 3-1000 | Modal | Equity | Credit |
| 3-2000 | Laba Ditahan | Equity | Credit |
| 4-1000 | Penjualan | Revenue | Credit |
| 5-1000 | Harga Pokok Penjualan | Expense | Debit |
| 6-2100 | Selisih Persediaan | Expense | Debit |
| 6-2200 | Selisih Kas | Expense | Debit |
| 6-9000 | Beban Lain-lain | Expense | Debit |

## Posting rules v1 (MVP-OD-2)

| Event | Debit | Credit |
|---|---|---|
| `INVENTORY_RECEIVED` valued | 1-1400 `totalCost` | 2-1150 `totalCost` |
| `INVENTORY_ISSUED` valued | 5-1000 `totalCost` | 1-1400 `totalCost` |
| `INVENTORY_ADJUSTED` loss | 6-2100 absolute `totalCostDelta` | 1-1400 absolute `totalCostDelta` |
| `INVENTORY_ADJUSTED` gain | 1-1400 `totalCostDelta` | 6-2100 `totalCostDelta` |
| `INVOICE_ISSUED` | 1-1300 `total` | 4-1000 `subtotal`, 2-1300 `taxAmount` when positive |
| `PAYMENT_RECEIVED` TUNAI | 1-1110 `amount` | 1-1300 `amount` |
| `CASH_CUSTODY_VERIFIED` | 1-1100 `countedAmount`, 6-2200 shortage | 1-1110 `declaredAmount`, 6-2200 overage |

An unvalued inventory event enters the posting exception queue; it never posts zero. Every journal balances with zero IDR tolerance. Posted journals are immutable; correction uses a reversal.

## Period, cost, tax and AR timing

- Calendar-month periods are determined from `businessDate` in Asia/Jakarta. A closed period receives no posting; its event remains visible as an exception.
- Inventory valuation uses moving-average cost by warehouse, product and UoM (MVP-OD-4). Inventory owns cost calculation. Finance consumes the event's valued amount and never recalculates it.
- PPN Keluaran uses only the invoice's `taxAmount` (MVP-OD-3). The current POS invoice carries zero tax. PKP status, rate and inclusive-pricing treatment need Finance/Tax approval before production use.
- POS cash payment may precede invoice issue. The temporary credit balance in Piutang Usaha is expected until handover issues the invoice; reconciliation must show it rather than suppress it.
- A manual journal requires an approver other than its maker. A manual journal never changes an operational document.

## Sign-off

Finance must decide MVP-OD-1 (COA), MVP-OD-2 (posting matrix), MVP-OD-3 (PPN), and MVP-OD-4 (costing) before any production use. The broader Product PRD contains different recognition and control flows for later phases. This record implements only the MVP demo contract and does not resolve those production decisions.
