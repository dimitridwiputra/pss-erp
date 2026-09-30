import { z } from 'zod';
import { BusinessDateSchema, UtcTimestampSchema } from '../primitives';
import { eventCatalog } from './catalog.generated';
export { v7 as newEventId } from 'uuid';

export { eventCatalog } from './catalog.generated';
export type EventName = (typeof eventCatalog)[number]['name'];

const eventNames = eventCatalog.map((event) => event.name) as [EventName, ...EventName[]];
export const EventNameSchema = z.enum(eventNames);

export const EventActorSchema = z.strictObject({
  userId: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).optional(),
  onBehalfOf: z.string().min(1).optional(),
  serviceIdentity: z.string().min(1).optional(),
});

export const EventEnvelopeSchema = z.strictObject({
  eventId: z.uuidv7(),
  eventType: EventNameSchema,
  eventVersion: z.int().positive(),
  occurredAt: UtcTimestampSchema,
  businessDate: BusinessDateSchema,
  organizationId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateVersion: z.int().positive(),
  producer: z.string().min(1),
  actor: EventActorSchema.optional(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1),
  payload: z.unknown().refine((value) => value !== undefined, 'Payload is required.'),
});

// Only implemented payload schemas may be published. Catalog presence alone grants no publish permission.
export const DeliveryOrderClosedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('DELIVERY_ORDER_CLOSED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({ doId: z.string().min(1) }),
});

export const DeliveryOrderDeliveredV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('DELIVERY_ORDER_DELIVERED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    doId: z.uuid(),
    deliveredAt: UtcTimestampSchema,
    lines: z.array(z.strictObject({ productId: z.uuid(), qtyDelivered: z.string() })).min(1),
    source: z.enum(['ADMIN', 'DRIVER']),
  }),
});

export const ApprovalRequestedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('APPROVAL_REQUESTED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    requestId: z.uuid(), type: z.string().min(1), subjectRef: z.string().min(1),
    ownerDomain: z.string().min(1), decision: z.literal('PENDING'),
  }),
});

export const ApprovalDecidedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('APPROVAL_DECIDED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    requestId: z.uuid(), type: z.string().min(1), subjectRef: z.string().min(1),
    ownerDomain: z.string().min(1), decision: z.enum(['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']),
    decidedBy: z.uuid().optional(), level: z.int().positive(),
  }),
});

// MVP v1 payloads (docs/mvp/MVP_PLAN.md §5). The wire format is fixed-scale so a consumer never
// re-rounds: money has exactly 2 places, quantity exactly 3, a unit cost exactly 4 (the inventory
// ledger's numeric(18,4), MVP-OD-13), and only deltas and variances may be signed.
const MoneyV1 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/, 'Money is a decimal string with 2 places.');
const SignedMoneyV1 = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/, 'Money is a signed decimal string with 2 places.')
  .refine((value) => !/^-0\.00$/.test(value), 'Negative zero is not a money value.');
const QuantityV1 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{3}$/, 'Quantity is a decimal string with 3 places.');
const SignedQuantityV1 = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{3}$/, 'Quantity is a signed decimal string with 3 places.')
  .refine((value) => !/^-0\.000$/.test(value), 'Negative zero is not a quantity value.');
const UnitCostV1 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{4}$/, 'Unit cost is a decimal string with 4 places.');

// A null cost means the movement is unvalued; finance routes it to the exception queue (AGENTS.md §3.7).
const inventoryMovementPayloadV1 = {
  movementId: z.uuid(), warehouseId: z.uuid(), productId: z.uuid(), uom: z.string().min(1),
  qty: QuantityV1, unitCost: UnitCostV1.nullable(), totalCost: MoneyV1.nullable(), sourceId: z.uuid(),
  businessDate: BusinessDateSchema,
};

export const InventoryReceivedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('INVENTORY_RECEIVED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({ ...inventoryMovementPayloadV1, sourceType: z.enum(['GOODS_RECEIPT', 'WMS_RECEIPT']) }),
});

export const InventoryIssuedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('INVENTORY_ISSUED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({ ...inventoryMovementPayloadV1, sourceType: z.literal('SALES_FULFILLMENT') }),
});

export const InventoryAdjustedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('INVENTORY_ADJUSTED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    adjustmentId: z.uuid(), warehouseId: z.uuid(), productId: z.uuid(), uom: z.string().min(1),
    qtyDelta: SignedQuantityV1, unitCost: UnitCostV1.nullable(), totalCostDelta: SignedMoneyV1.nullable(),
    reasonCode: z.string().min(1), businessDate: BusinessDateSchema,
  }),
});

export const InvoiceIssuedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('INVOICE_ISSUED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    invoiceId: z.uuid(), invoiceNumber: z.string().min(1), customerId: z.uuid(), branchId: z.uuid(),
    salesOrderId: z.uuid(), channel: z.literal('POS'), currency: z.literal('IDR'),
    subtotal: MoneyV1, taxAmount: MoneyV1, total: MoneyV1, businessDate: BusinessDateSchema,
  }),
});

export const PaymentReceivedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('PAYMENT_RECEIVED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    paymentId: z.uuid(), method: z.literal('TUNAI'), amount: MoneyV1, currency: z.literal('IDR'),
    customerId: z.uuid(), referenceType: z.literal('POS_SALE'), referenceId: z.uuid(), invoiceId: z.uuid().nullable(),
    receivedBy: z.uuid(), cashLocationType: z.literal('POS_SHIFT'), cashLocationId: z.uuid(),
    businessDate: BusinessDateSchema,
  }),
});

export const CashCustodyVerifiedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('CASH_CUSTODY_VERIFIED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    cashCustodyRecordId: z.uuid(), declaredAmount: MoneyV1, countedAmount: MoneyV1,
    varianceAmount: SignedMoneyV1, verifiedBy: z.uuid(), sourceType: z.literal('POS_SHIFT'), sourceId: z.uuid(),
    businessDate: BusinessDateSchema,
  }),
});

export const JournalPostedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('JOURNAL_POSTED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({
    journalId: z.uuid(), journalNumber: z.string().min(1), periodCode: z.string().min(1),
    businessDate: BusinessDateSchema, sourceType: z.string().min(1), sourceEventId: z.uuidv7().nullable(),
    totalDebit: MoneyV1, totalCredit: MoneyV1,
  }),
});

export const JournalReversedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('JOURNAL_REVERSED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({ journalId: z.uuid(), reversalJournalId: z.uuid(), reasonCode: z.string().min(1) }),
});

export const AccountingPeriodClosedV1Schema = EventEnvelopeSchema.extend({
  eventType: z.literal('ACCOUNTING_PERIOD_CLOSED'),
  eventVersion: z.literal(1),
  payload: z.strictObject({ periodId: z.uuid(), periodCode: z.string().min(1), closedBy: z.uuid() }),
});

export const eventSchemaRegistry = {
  DELIVERY_ORDER_CLOSED: { 1: DeliveryOrderClosedV1Schema },
  DELIVERY_ORDER_DELIVERED: { 1: DeliveryOrderDeliveredV1Schema },
  APPROVAL_REQUESTED: { 1: ApprovalRequestedV1Schema },
  APPROVAL_DECIDED: { 1: ApprovalDecidedV1Schema },
  INVENTORY_RECEIVED: { 1: InventoryReceivedV1Schema },
  INVENTORY_ISSUED: { 1: InventoryIssuedV1Schema },
  INVENTORY_ADJUSTED: { 1: InventoryAdjustedV1Schema },
  INVOICE_ISSUED: { 1: InvoiceIssuedV1Schema },
  PAYMENT_RECEIVED: { 1: PaymentReceivedV1Schema },
  CASH_CUSTODY_VERIFIED: { 1: CashCustodyVerifiedV1Schema },
  JOURNAL_POSTED: { 1: JournalPostedV1Schema },
  JOURNAL_REVERSED: { 1: JournalReversedV1Schema },
  ACCOUNTING_PERIOD_CLOSED: { 1: AccountingPeriodClosedV1Schema },
} satisfies Partial<Record<EventName, Record<number, z.ZodType>>>;

export function parseEventForPublication(input: unknown) {
  const envelope = EventEnvelopeSchema.parse(input);
  const registered = eventSchemaRegistry as Partial<Record<EventName, Record<number, z.ZodType>>>;
  const schema = registered[envelope.eventType]?.[envelope.eventVersion];
  if (!schema) {
    throw new Error(`No payload schema registered for ${envelope.eventType} v${envelope.eventVersion}.`);
  }
  const catalogEntry = eventCatalog.find((entry) => entry.name === envelope.eventType);
  if (!catalogEntry || envelope.producer !== catalogEntry.producer || envelope.aggregateType !== catalogEntry.aggregate) {
    throw new Error(`Producer or aggregate does not match Appendix C for ${envelope.eventType}.`);
  }
  schema.parse(input);
  return envelope;
}
