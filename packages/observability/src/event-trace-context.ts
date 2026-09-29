import {
  deriveTraceId,
  newSpanId,
  newTraceContext,
  parseTraceContext,
  type TraceContext,
  type TraceHeaders,
} from './trace-context';
import { runWithTraceContext } from './trace-context-storage';

/**
 * Trace propagation across the outbox -> worker -> consumer boundary (OBS-001,
 * AGENTS.md §10). Dependency-free: the shape below is the subset of
 * `EventEnvelopeSchema` in `@pss/contracts` that a consumer needs, so this module
 * pulls in neither the contract package nor a broker client.
 */
export type TraceableEventEnvelope = {
  readonly eventId: string;
  readonly eventType: string;
  readonly organizationId?: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly producer?: string;
  readonly correlationId: string;
  readonly causationId: string;
  /**
   * Not yet part of `EventEnvelopeSchema` (the envelope is a `strictObject`).
   * Accepted here so the chain becomes exact the moment PLT-003 adds the field;
   * until then the trace id is derived from `correlationId`.
   */
  readonly traceparent?: string;
  readonly tracestate?: string;
};

/** Allow-listed event identity for log fields. Payloads are never copied into logs. */
export type EventTraceAttributes = {
  eventId: string;
  eventType: string;
  causationId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
};

export function eventTraceAttributes(envelope: TraceableEventEnvelope): EventTraceAttributes {
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    causationId: envelope.causationId,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    aggregateVersion: envelope.aggregateVersion,
  };
}

export type EventTraceSeed = {
  readonly context: TraceContext;
  readonly attributes: EventTraceAttributes;
};

/**
 * Child-span one event into the trace of its business flow. A replayed or duplicated
 * event produces a new span id but keeps the trace id, so dedupe stays the inbox
 * consumer's decision (AGENTS.md §3.6) and never the tracer's.
 */
export function traceContextFromEvent(envelope: TraceableEventEnvelope): EventTraceSeed {
  const headers: TraceHeaders = { traceparent: envelope.traceparent, tracestate: envelope.tracestate };
  const inherited = parseTraceContext(headers);
  const context = inherited
    ? { ...inherited, spanId: newSpanId() }
    : newTraceContext({ traceId: deriveTraceId(envelope.correlationId) });
  return { context, attributes: eventTraceAttributes(envelope) };
}

/** Run one consumer inside the event's trace scope; the logger picks the ids up. */
export function withEventTraceContext<T>(envelope: TraceableEventEnvelope, run: (seed: EventTraceSeed) => T): T {
  const seed = traceContextFromEvent(envelope);
  return runWithTraceContext(seed.context, () => run(seed));
}
