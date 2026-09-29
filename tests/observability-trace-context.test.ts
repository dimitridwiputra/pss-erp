import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpRequestLogging,
  createServiceLogger,
} from '../packages/observability/src/http-request-logging';
import {
  deriveTraceId,
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  newTraceContext,
  parseTraceContext,
  parseTraceparent,
  parseTracestate,
  resolveInboundTraceContext,
} from '../packages/observability/src/trace-context';
import {
  currentTraceContext,
  runWithTraceContext,
  type TraceContext,
} from '../packages/observability/src/trace-context-storage';
import { withEventTraceContext, type TraceableEventEnvelope } from '../packages/observability/src/event-trace-context';

const upstreamTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const upstreamSpanId = '00f067aa0ba902b7';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function collectLines(): { lines: string[]; sink: { write: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, sink: { write: (line: string) => { lines.push(line); } } };
}

async function startServer(middleware: ReturnType<typeof createHttpRequestLogging>, headers: Record<string, string>) {
  const server = createServer((request, response) => {
    middleware(request, response, () => { request.resume(); response.end('ok'); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port.');
  return fetch(`http://127.0.0.1:${address.port}/health/live`, { headers });
}

const envelope: TraceableEventEnvelope = {
  eventId: '0195f0c1-7c1e-7000-8000-000000000001',
  eventType: 'DELIVERY_ORDER_DELIVERED',
  organizationId: 'pss',
  aggregateType: 'DeliveryOrder',
  aggregateId: 'do-1',
  aggregateVersion: 2,
  producer: 'fulfillment',
  correlationId: 'corr-456',
  causationId: 'command-1',
};

describe('OBS-001 trace context', () => {
  it('OBS-001.R02 parses only spec-conformant W3C ids', () => {
    expect(parseTraceparent(`00-${upstreamTraceId}-${upstreamSpanId}-01`))
      .toEqual({ traceId: upstreamTraceId, spanId: upstreamSpanId, traceFlags: '01' });

    // Uppercase hex, all-zero ids, the reserved ff version, a truncated flags field, and a
    // version-00 header with trailing data are all rejected rather than trusted.
    expect(parseTraceparent(`00-${upstreamTraceId.toUpperCase()}-${upstreamSpanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${upstreamSpanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${upstreamTraceId}-${'0'.repeat(16)}-01`)).toBeUndefined();
    expect(parseTraceparent(`ff-${upstreamTraceId}-${upstreamSpanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${upstreamTraceId}-${upstreamSpanId}-0`)).toBeUndefined();
    expect(parseTraceparent(`00-${upstreamTraceId}-${upstreamSpanId}-01-extra`)).toBeUndefined();
    expect(parseTraceparent([`00-${upstreamTraceId}-${upstreamSpanId}-01`])).toEqual({
      traceId: upstreamTraceId, spanId: upstreamSpanId, traceFlags: '01',
    });
    expect(parseTraceparent(undefined)).toBeUndefined();
  });

  it('keeps a higher version but drops its unknown trailing fields', () => {
    expect(parseTraceparent(`01-${upstreamTraceId}-${upstreamSpanId}-01-future`))
      .toEqual({ traceId: upstreamTraceId, spanId: upstreamSpanId, traceFlags: '01' });
  });

  it('validates tracestate members and the 512-character header limit', () => {
    expect(parseTracestate('vendor=abc,other=1')).toBe('vendor=abc,other=1');
    expect(parseTracestate('VENDOR=abc')).toBeUndefined();
    expect(parseTracestate('vendor=abc,')).toBe('vendor=abc');
    expect(parseTracestate('vendor=a=b')).toBeUndefined();
    expect(parseTracestate('vendor=abc ')).toBe('vendor=abc');
    expect(parseTracestate(`vendor=${'a'.repeat(600)}`)).toBeUndefined();
    expect(parseTracestate('a=1,b=2,c=3,d=4,e=5,f=6,g=7,h=8,i=9,j=10,k=11,l=12,m=13,n=14,o=15,p=16,q=17,r=18,s=19,t=20,u=21,v=22,w=23,x=24,y=25,z=26,A=27,B=28,C=29,D=30,E=31,F=32,G=33'))
      .toBeUndefined();
  });

  it('generates and formats valid ids only', () => {
    const generated = newTraceContext();
    expect(isValidTraceId(generated.traceId)).toBe(true);
    expect(isValidSpanId(generated.spanId)).toBe(true);
    expect(generated.traceFlags).toBe('01');
    expect(formatTraceparent(generated)).toBe(`00-${generated.traceId}-${generated.spanId}-01`);
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
  });

  it('derives a stable, valid trace id from a correlation id', () => {
    expect(deriveTraceId('corr-456')).toBe(deriveTraceId('corr-456'));
    expect(deriveTraceId('corr-456')).not.toBe(deriveTraceId('corr-457'));
    expect(isValidTraceId(deriveTraceId('corr-456'))).toBe(true);
  });

  it('prefers a valid inbound traceparent and otherwise starts a derivable trace', () => {
    const continued = resolveInboundTraceContext({ traceparent: `00-${upstreamTraceId}-${upstreamSpanId}-01` }, 'corr-456');
    expect(continued.traceId).toBe(upstreamTraceId);
    expect(continued.spanId).not.toBe(upstreamSpanId);

    const started = resolveInboundTraceContext({ traceparent: 'not-a-traceparent' }, 'corr-456');
    expect(started.traceId).toBe(deriveTraceId('corr-456'));
    expect(parseTraceContext({ traceparent: 'not-a-traceparent' })).toBeUndefined();
  });
});

describe('OBS-001 request scope', () => {
  it('OBS-001.AC01 logs the populated traceId/spanId instead of null', async () => {
    const { lines, sink } = collectLines();
    const response = await startServer(createHttpRequestLogging('api', sink), {
      'x-request-id': 'req_123',
      'x-correlation-id': 'corr-456',
      traceparent: `00-${upstreamTraceId}-${upstreamSpanId}-01`,
      tracestate: 'vendor=abc',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.headers.get('x-request-id')).toBe('req_123');
    expect(response.headers.get('x-correlation-id')).toBe('corr-456');
    expect(response.headers.get('traceparent'))
      .toMatch(new RegExp(`^00-${upstreamTraceId}-[0-9a-f]{16}-01$`));
    expect(response.headers.get('tracestate')).toBe('vendor=abc');

    const log = JSON.parse(lines[0] ?? '{}');
    expect(log).toMatchObject({ requestId: 'req_123', correlationId: 'corr-456', traceId: upstreamTraceId });
    expect(log.traceId).not.toBeNull();
    expect(log.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(lines.join('')).not.toContain('"traceId":null');
  });

  it('derives a trace id shared with the event consumer when no inbound traceparent exists', async () => {
    const { lines, sink } = collectLines();
    const response = await startServer(createHttpRequestLogging('api', sink), { 'x-correlation-id': 'corr-456' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const requestTrace = JSON.parse(lines[0] ?? '{}');

    expect(response.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    withEventTraceContext({ ...envelope }, (seed) => {
      expect(seed.context.traceId).toBe(requestTrace.traceId);
      expect(seed.context.spanId).not.toBe(requestTrace.spanId);
    });
  });

  it('lets a downstream logger inside the scope inherit the trace ids', async () => {
    const { lines, sink } = collectLines();
    const downstream = createServiceLogger('downstream', sink);
    const context: TraceContext = newTraceContext();
    runWithTraceContext(context, () => {
      downstream.info({ step: 'inner' }, 'inner log');
    });
    downstream.info({ step: 'outer' }, 'outer log');
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0]).toMatchObject({ traceId: context.traceId, spanId: context.spanId });
    expect(parsed[1].traceId).toBeUndefined();
  });

  it('keeps the scope out of a concurrent request', async () => {
    const { lines, sink } = collectLines();
    const seen: Array<string | undefined> = [];
    const first = newTraceContext();
    const second = newTraceContext();
    await Promise.all([
      runWithTraceContext(first, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(currentTraceContext()?.traceId); }),
      runWithTraceContext(second, async () => { await new Promise((r) => setTimeout(r, 1)); seen.push(currentTraceContext()?.traceId); }),
    ]);
    createServiceLogger('api', sink).info({}, 'after');
    expect(seen.sort()).toEqual([first.traceId, second.traceId].sort());
    expect(currentTraceContext()).toBeUndefined();
    expect(JSON.parse(lines[0] ?? '{}').traceId).toBeUndefined();
  });
});

describe('OBS-001 event propagation', () => {
  it('OBS-001.AC01 keeps one trace across the outbox and consumer boundary', () => {
    withEventTraceContext(envelope, (seed) => {
      expect(seed.attributes).toEqual({
        eventId: envelope.eventId,
        eventType: 'DELIVERY_ORDER_DELIVERED',
        causationId: 'command-1',
        aggregateType: 'DeliveryOrder',
        aggregateId: 'do-1',
        aggregateVersion: 2,
      });
      expect(seed.context.traceId).toBe(deriveTraceId('corr-456'));
      expect(currentTraceContext()).toEqual(seed.context);
    });
    expect(currentTraceContext()).toBeUndefined();
  });

  it('child-spans a replayed event without changing its trace id', () => {
    const first = withEventTraceContext(envelope, (seed) => seed.context);
    const replay = withEventTraceContext(envelope, (seed) => seed.context);
    expect(replay.traceId).toBe(first.traceId);
    expect(replay.spanId).not.toBe(first.spanId);
  });

  it('forwards an explicit envelope traceparent when the contract carries one', () => {
    const seeded = withEventTraceContext(
      { ...envelope, traceparent: `00-${upstreamTraceId}-${upstreamSpanId}-01`, tracestate: 'vendor=abc' },
      (seed) => seed.context,
    );
    expect(seeded.traceId).toBe(upstreamTraceId);
    expect(seeded.spanId).not.toBe(upstreamSpanId);
    expect(seeded.traceState).toBe('vendor=abc');
  });
});
