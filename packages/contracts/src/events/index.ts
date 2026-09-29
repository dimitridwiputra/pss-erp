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

export const eventSchemaRegistry = {
  DELIVERY_ORDER_CLOSED: { 1: DeliveryOrderClosedV1Schema },
  DELIVERY_ORDER_DELIVERED: { 1: DeliveryOrderDeliveredV1Schema },
  APPROVAL_REQUESTED: { 1: ApprovalRequestedV1Schema },
  APPROVAL_DECIDED: { 1: ApprovalDecidedV1Schema },
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
