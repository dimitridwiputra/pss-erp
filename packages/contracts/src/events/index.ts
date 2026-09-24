import { z } from 'zod';
import { BusinessDateSchema, UtcTimestampSchema } from '../primitives';
import { eventCatalog } from './catalog.generated';

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

export const eventSchemaRegistry = {
  DELIVERY_ORDER_CLOSED: { 1: DeliveryOrderClosedV1Schema },
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
  return schema.parse(input);
}
