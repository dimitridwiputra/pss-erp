import { createHash, randomBytes } from 'node:crypto';

/**
 * W3C Trace Context propagation (https://www.w3.org/TR/trace-context/).
 *
 * Scope (OBS-001): this module only implements the wire format defined by the
 * specification — a fixed, tiny header grammar — so a request, an outbox event, and
 * a worker consumer can share one trace id. It is not a tracing SDK: span timing,
 * sampling, and export stay with OpenTelemetry (AGT §6; OD-185 is still open).
 *
 * Incoming ids are validated, never trusted. All-zero ids are rejected by the
 * specification and are regenerated here.
 */

const supportedVersion = '00';
const invalidVersion = 'ff';
const maximumTracestateLength = 512;
const maximumTracestateMembers = 32;

const versionPattern = /^[0-9a-f]{2}$/;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const flagsPattern = /^[0-9a-f]{2}$/;
const allZeroTraceId = /^0{32}$/;
const allZeroSpanId = /^0{16}$/;
const simpleKeyPattern = /^[a-z][a-z0-9_\-*/]{0,255}$/;
const tenantKeyPattern = /^[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13}$/;
// tracestate ABNF: `0*255(chr) nblk-chr`, i.e. 1-256 printable ASCII characters that
// exclude ',' (0x2C) and '=' (0x3D) and never end in a blank.
const tracestateCharClass = '\\x20-\\x2B\\x2D-\\x3C\\x3E-\\x7E';
const tracestateValuePattern = new RegExp(`^[${tracestateCharClass}]{0,255}[\\x21-\\x2B\\x2D-\\x3C\\x3E-\\x7E]$`);

export type TraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly traceState: string | undefined;
};

/** A parsed `traceparent` header without the optional `tracestate` companion. */
export type ParsedTraceparent = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
};

export type TraceHeaders = Readonly<Record<string, string | string[] | undefined>>;

const sampledTraceFlags = '01';

function singleHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

export function isValidTraceId(value: string): boolean {
  return traceIdPattern.test(value) && !allZeroTraceId.test(value);
}

export function isValidSpanId(value: string): boolean {
  return spanIdPattern.test(value) && !allZeroSpanId.test(value);
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * A trace id that a consumer can rebuild from the canonical event envelope alone.
 *
 * The envelope (AGENTS.md §10, `EventEnvelopeSchema` in `@pss/contracts`) carries
 * `correlationId` and `causationId` but no `traceparent`, so an outbox -> worker ->
 * consumer hop cannot forward a span id. Deriving the trace id from the correlation id
 * keeps one trace per business flow, which is what OBS-001.AC01 requires ("log api,
 * fulfillment consumer, invoicing, and finance posting share one correlationId").
 * A valid inbound `traceparent` always wins so an instrumented caller keeps its own trace.
 */
export function deriveTraceId(correlationId: string): string {
  const derived = createHash('sha256').update(correlationId, 'utf8').digest('hex').slice(0, 32);
  return allZeroTraceId.test(derived) ? newTraceId() : derived;
}

export function parseTraceparent(value: string | string[] | undefined): ParsedTraceparent | undefined {
  const header = singleHeader(value);
  if (!header) return undefined;
  const fields = header.split('-');
  const [rawVersion, traceId, spanId, traceFlags] = fields;
  if (fields.length < 4 || !rawVersion || !traceId || !spanId || !traceFlags) return undefined;
  if (!versionPattern.test(rawVersion) || rawVersion === invalidVersion) return undefined;
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId) || !flagsPattern.test(traceFlags)) return undefined;
  // version-format 00 is exactly 55 characters; higher versions may append fields that
  // a conformant receiver ignores instead of rejecting the whole header.
  if (rawVersion === supportedVersion && (header.length !== 55 || fields.length !== 4)) return undefined;
  return { traceId, spanId, traceFlags };
}

export function parseTracestate(value: string | string[] | undefined): string | undefined {
  const header = singleHeader(value);
  if (!header || header.length > maximumTracestateLength) return undefined;
  // Optional whitespace around a member is the OWS the ABNF allows at list boundaries;
  // HTTP field-value parsing already trims the header, so trimming again is consistent.
  const members = header.split(',').map((member) => member.trim()).filter((member) => member.length > 0);
  if (members.length === 0 || members.length > maximumTracestateMembers) return undefined;
  const valid = members.every((member) => {
    const separator = member.indexOf('=');
    if (separator < 1) return false;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    return (simpleKeyPattern.test(key) || tenantKeyPattern.test(key)) && tracestateValuePattern.test(memberValue);
  });
  return valid ? members.join(',') : undefined;
}

export function formatTraceparent(context: Pick<TraceContext, 'traceId' | 'spanId' | 'traceFlags'>): string {
  return `${supportedVersion}-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

export function parseTraceContext(headers: TraceHeaders): TraceContext | undefined {
  const parsed = parseTraceparent(headers.traceparent);
  if (!parsed) return undefined;
  const traceState = parseTracestate(headers.tracestate);
  return { ...parsed, traceState };
}

export function newTraceContext(options: { traceId?: string; traceFlags?: string; traceState?: string | undefined } = {}): TraceContext {
  const requestedTraceId = options.traceId;
  const requestedFlags = options.traceFlags;
  return {
    traceId: requestedTraceId && isValidTraceId(requestedTraceId) ? requestedTraceId : newTraceId(),
    spanId: newSpanId(),
    traceFlags: requestedFlags && flagsPattern.test(requestedFlags) ? requestedFlags : sampledTraceFlags,
    traceState: options.traceState,
  };
}

/**
 * Continue an inbound trace when its `traceparent` is valid, otherwise start one that a
 * consumer of the resulting event can still reconstruct from the correlation id.
 *
 * The inbound parent id is never reused: this process starts its own child span, so the
 * caller's span and this one stay distinguishable in a trace viewer.
 */
export function resolveInboundTraceContext(headers: TraceHeaders, correlationId: string): TraceContext {
  const inherited = parseTraceContext(headers);
  if (!inherited) return newTraceContext({ traceId: deriveTraceId(correlationId) });
  return { ...inherited, spanId: newSpanId() };
}
