import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { BusinessDateSchema, MoneyAmountSchema } from '../packages/contracts/src/primitives';
import { EventEnvelopeSchema, eventCatalog, parseEventForPublication } from '../packages/contracts/src/events';
import { checkEventSchemaCompatibility, checkOpenApiCompatibility } from '../packages/contracts/scripts/compatibility.mjs';

const validClosedEvent = {
  eventId: '019a0000-0000-7000-8000-000000000001',
  eventType: 'DELIVERY_ORDER_CLOSED',
  eventVersion: 1,
  occurredAt: '2026-09-24T00:00:00Z',
  businessDate: '2026-09-24',
  organizationId: 'org-example',
  aggregateType: 'DeliveryOrder',
  aggregateId: 'do-example',
  aggregateVersion: 1,
  producer: 'fulfillment',
  correlationId: 'corr-example',
  causationId: 'cause-example',
  payload: { doId: 'do-example' },
};

describe('PLT-003 event contracts', () => {
  it('loads all Appendix C names but publishes only registered payload versions', () => {
    expect(eventCatalog).toHaveLength(164);
    expect(new Set(eventCatalog.map(({ name }) => name)).size).toBe(164);
    expect(parseEventForPublication(validClosedEvent)).toEqual(validClosedEvent);
    expect(() => parseEventForPublication({ ...validClosedEvent, eventType: 'CUSTOMER_CREATED' }))
      .toThrow(/No payload schema registered/);
    expect(() => parseEventForPublication({ ...validClosedEvent, eventType: 'MADE_UP_EVENT' }))
      .toThrow();
  });

  it('requires producer and validates identity, source and payload at the boundary', () => {
    expect(EventEnvelopeSchema.safeParse({ ...validClosedEvent, producer: undefined }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...validClosedEvent, payload: undefined }).success).toBe(false);
    expect(() => parseEventForPublication({ ...validClosedEvent, producer: 'fleet' })).toThrow(/Producer or aggregate/);
    expect(() => parseEventForPublication({ ...validClosedEvent, aggregateType: 'Invoice' })).toThrow(/Producer or aggregate/);
    expect(() => parseEventForPublication({ ...validClosedEvent, payload: {} })).toThrow();
    expect(() => parseEventForPublication({ ...validClosedEvent, eventId: 'not-a-uuidv7' })).toThrow();
  });

  it('keeps money decimal and rejects invalid calendar dates', () => {
    expect(MoneyAmountSchema.parse('1234.50')).toBe('1234.50');
    expect(MoneyAmountSchema.safeParse(1234.5).success).toBe(false);
    expect(BusinessDateSchema.safeParse('2026-02-30').success).toBe(false);
  });

  it('allows optional additions and rejects breaking changes to an existing event version', async () => {
    const baseline = JSON.parse(await readFile(new URL('../docs/events/schema-baseline.json', import.meta.url), 'utf8'));
    expect(() => checkEventSchemaCompatibility(baseline, baseline)).not.toThrow();
    const changed = structuredClone(baseline);
    changed.schemas['DELIVERY_ORDER_CLOSED@1'].properties.payload.required = [];
    expect(() => checkEventSchemaCompatibility(baseline, changed)).toThrow(/Breaking change/);
    expect(() => checkEventSchemaCompatibility(baseline, { schemas: {} })).toThrow(/Breaking change/);
    const additive = structuredClone(baseline);
    additive.schemas['DELIVERY_ORDER_CLOSED@1'].properties.payload.properties.note = { type: 'string' };
    expect(() => checkEventSchemaCompatibility(baseline, additive)).not.toThrow();
  });

  it('rejects removal of an existing API route or response field', async () => {
    const baseline = JSON.parse(await readFile(new URL('../docs/api/openapi-baseline.json', import.meta.url), 'utf8'));
    expect(() => checkOpenApiCompatibility(baseline, baseline)).not.toThrow();
    const removedRoute = structuredClone(baseline);
    delete removedRoute.paths['/health/ready'];
    expect(() => checkOpenApiCompatibility(baseline, removedRoute)).toThrow(/Breaking OpenAPI change/);
    const removedField = structuredClone(baseline);
    delete removedField.components.schemas.HealthResponse.properties.service;
    expect(() => checkOpenApiCompatibility(baseline, removedField)).toThrow(/Breaking OpenAPI change/);
  });
});
