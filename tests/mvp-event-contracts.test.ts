import { describe, expect, it } from 'vitest';
import { eventCatalog, eventSchemaRegistry, parseEventForPublication } from '../packages/contracts/src/events';

// docs/mvp/MVP_PLAN.md §5: one valid example per v1 event, so each rule below is tested against a
// payload that would otherwise pass.
const ids = {
  a: '0199a000-0000-4000-8000-000000000001',
  b: '0199a000-0000-4000-8000-000000000002',
  c: '0199a000-0000-4000-8000-000000000003',
  d: '0199a000-0000-4000-8000-000000000004',
  e: '0199a000-0000-4000-8000-000000000005',
};

const payloads: Record<string, Record<string, unknown>> = {
  INVENTORY_RECEIVED: {
    movementId: ids.a, warehouseId: ids.b, productId: ids.c, uom: 'KARTON', qty: '10.000',
    unitCost: '95000.00', totalCost: '950000.00', sourceType: 'GOODS_RECEIPT', sourceId: ids.d, businessDate: '2026-10-01',
  },
  INVENTORY_ISSUED: {
    movementId: ids.a, warehouseId: ids.b, productId: ids.c, uom: 'KARTON', qty: '2.000',
    unitCost: '95000.00', totalCost: '190000.00', sourceType: 'SALES_FULFILLMENT', sourceId: ids.d, businessDate: '2026-10-01',
  },
  INVENTORY_ADJUSTED: {
    adjustmentId: ids.a, warehouseId: ids.b, productId: ids.c, uom: 'PCS', qtyDelta: '-3.000',
    unitCost: '2375.00', totalCostDelta: '-7125.00', reasonCode: 'DAMAGED', businessDate: '2026-10-01',
  },
  INVOICE_ISSUED: {
    invoiceId: ids.a, invoiceNumber: 'INV-KSR-000001', customerId: ids.b, branchId: ids.c, salesOrderId: ids.d,
    channel: 'POS', currency: 'IDR', subtotal: '236000.00', taxAmount: '0.00', total: '236000.00', businessDate: '2026-10-01',
  },
  PAYMENT_RECEIVED: {
    paymentId: ids.a, method: 'TUNAI', amount: '236000.00', currency: 'IDR', customerId: ids.b,
    referenceType: 'POS_SALE', referenceId: ids.c, invoiceId: null, receivedBy: ids.d,
    cashLocationType: 'POS_SHIFT', cashLocationId: ids.e, businessDate: '2026-10-01',
  },
  CASH_CUSTODY_VERIFIED: {
    cashCustodyRecordId: ids.a, declaredAmount: '236000.00', countedAmount: '235000.00', varianceAmount: '-1000.00',
    verifiedBy: ids.b, sourceType: 'POS_SHIFT', sourceId: ids.c, businessDate: '2026-10-01',
  },
  JOURNAL_POSTED: {
    journalId: ids.a, journalNumber: 'JU-2026-10-0001', periodCode: '2026-10', businessDate: '2026-10-01',
    sourceType: 'INVOICE_ISSUED', sourceEventId: '019a0000-0000-7000-8000-000000000009',
    totalDebit: '236000.00', totalCredit: '236000.00',
  },
  JOURNAL_REVERSED: { journalId: ids.a, reversalJournalId: ids.b, reasonCode: 'ACCOUNTING_CORRECTION' },
  ACCOUNTING_PERIOD_CLOSED: { periodId: ids.a, periodCode: '2026-10', closedBy: ids.b },
};

function envelope(eventType: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  const entry = eventCatalog.find((event) => event.name === eventType);
  if (!entry) throw new Error(`${eventType} is not in the catalog.`);
  return {
    eventId: '019a0000-0000-7000-8000-000000000001',
    eventType,
    eventVersion: 1,
    occurredAt: '2026-10-01T03:00:00Z',
    businessDate: '2026-10-01',
    organizationId: ids.e,
    aggregateType: entry.aggregate,
    aggregateId: ids.a,
    aggregateVersion: 1,
    producer: entry.producer,
    correlationId: 'corr-example',
    causationId: 'cause-example',
    payload,
    ...overrides,
  };
}

// Each field that carries money, per event, so the float rule is checked on every one of them.
const moneyFields: Record<string, string[]> = {
  INVENTORY_RECEIVED: ['unitCost', 'totalCost'],
  INVENTORY_ISSUED: ['unitCost', 'totalCost'],
  INVENTORY_ADJUSTED: ['unitCost', 'totalCostDelta'],
  INVOICE_ISSUED: ['subtotal', 'taxAmount', 'total'],
  PAYMENT_RECEIVED: ['amount'],
  CASH_CUSTODY_VERIFIED: ['declaredAmount', 'countedAmount', 'varianceAmount'],
  JOURNAL_POSTED: ['totalDebit', 'totalCredit'],
};

describe('MVP v1 event payload contracts (MVP_PLAN §5)', () => {
  const events = Object.keys(payloads);

  it('registers every §5 event at version 1', () => {
    for (const eventType of events) {
      expect(eventSchemaRegistry).toHaveProperty([eventType, '1']);
    }
  });

  it.each(events)('%s: accepts a valid payload', (eventType) => {
    expect(() => parseEventForPublication(envelope(eventType, payloads[eventType]))).not.toThrow();
  });

  it.each(events)('%s: rejects an extra payload field', (eventType) => {
    expect(() => parseEventForPublication(envelope(eventType, { ...payloads[eventType], unexpected: 'x' }))).toThrow();
  });

  it.each(events)('%s: rejects a missing payload field', (eventType) => {
    const [first] = Object.keys(payloads[eventType]);
    const { [first]: _omitted, ...rest } = payloads[eventType];
    expect(() => parseEventForPublication(envelope(eventType, rest))).toThrow();
  });

  it.each(events)('%s: rejects the wrong producer', (eventType) => {
    expect(() => parseEventForPublication(envelope(eventType, payloads[eventType], { producer: 'pos' })))
      .toThrow(/Producer or aggregate/);
  });

  it.each(Object.entries(moneyFields).flatMap(([eventType, fields]) => fields.map((field) => [eventType, field])))(
    '%s.%s: rejects float money and the wrong scale',
    (eventType, field) => {
      for (const bad of [236000, 236000.5, '236000', '236000.5', '236000.000', '1e5']) {
        expect(() => parseEventForPublication(envelope(eventType, { ...payloads[eventType], [field]: bad }))).toThrow();
      }
    },
  );

  it('accepts an unvalued movement (null cost) and a signed variance, but never negative zero', () => {
    const unvalued = { ...payloads.INVENTORY_RECEIVED, sourceType: 'WMS_RECEIPT', unitCost: null, totalCost: null };
    expect(() => parseEventForPublication(envelope('INVENTORY_RECEIVED', unvalued))).not.toThrow();
    expect(() => parseEventForPublication(envelope('CASH_CUSTODY_VERIFIED', { ...payloads.CASH_CUSTODY_VERIFIED, varianceAmount: '1000.00' }))).not.toThrow();
    expect(() => parseEventForPublication(envelope('CASH_CUSTODY_VERIFIED', { ...payloads.CASH_CUSTODY_VERIFIED, varianceAmount: '-0.00' }))).toThrow();
  });

  it('rejects a negative amount where only a delta or variance may be signed', () => {
    expect(() => parseEventForPublication(envelope('PAYMENT_RECEIVED', { ...payloads.PAYMENT_RECEIVED, amount: '-236000.00' }))).toThrow();
    expect(() => parseEventForPublication(envelope('INVENTORY_ISSUED', { ...payloads.INVENTORY_ISSUED, qty: '-2.000' }))).toThrow();
  });

  it('rejects quantities that are not 3-place decimal strings', () => {
    for (const bad of [2, '2', '2.00', '2.0000']) {
      expect(() => parseEventForPublication(envelope('INVENTORY_ISSUED', { ...payloads.INVENTORY_ISSUED, qty: bad }))).toThrow();
    }
  });

  it('rejects a source type outside the event’s allowed set', () => {
    expect(() => parseEventForPublication(envelope('INVENTORY_ISSUED', { ...payloads.INVENTORY_ISSUED, sourceType: 'GOODS_RECEIPT' }))).toThrow();
    expect(() => parseEventForPublication(envelope('PAYMENT_RECEIVED', { ...payloads.PAYMENT_RECEIVED, method: 'QRIS' }))).toThrow();
  });
});
