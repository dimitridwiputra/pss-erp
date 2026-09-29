import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pino, { type Logger } from 'pino';
import { formatTraceparent, resolveInboundTraceContext, type TraceContext } from './trace-context';
import { currentTraceFields, runWithTraceContext } from './trace-context-storage';

export type RequestIdentity = {
  requestId: string;
  correlationId: string;
};

export type RequestContext = RequestIdentity & {
  trace: TraceContext;
};

export type ObservedRequest = IncomingMessage & {
  pssContext?: RequestContext;
  pssLogger?: Logger;
};

type HeaderValue = string | string[] | undefined;

function safeIdentifier(value: HeaderValue): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) && !/^\d{10,18}$/.test(value)
    ? value : undefined;
}

export function resolveRequestContext(headers: Record<string, HeaderValue>): RequestIdentity {
  const requestId = safeIdentifier(headers['x-request-id']) ?? randomUUID();
  return {
    requestId,
    correlationId: safeIdentifier(headers['x-correlation-id']) ?? requestId,
  };
}

export function requestContextFrom(request: ObservedRequest): RequestContext {
  if (request.pssContext) return request.pssContext;
  const identity = resolveRequestContext(request.headers);
  return { ...identity, trace: resolveInboundTraceContext(request.headers, identity.correlationId) };
}

export function createServiceLogger(service: string, destination?: pino.DestinationStream): Logger {
  return pino({
    base: {
      service,
      env: process.env.NODE_ENV ?? 'development',
      organizationId: null,
    },
    // OBS-001.R02: every line written inside a traced request, job, or consumer scope
    // carries the active W3C ids. Outside such a scope no trace fields are written.
    mixin: (mergeObject: object) => Object.assign(mergeObject, currentTraceFields()),
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (level) => ({ level }) },
    // HTTP logs contain only allow-listed metadata. Bodies, headers, and URL
    // query strings are never passed to the logger.
    level: process.env.LOG_LEVEL ?? 'info',
  }, destination);
}

/**
 * Express/Nest middleware for OBS-001.AC04 and OBS-001.R02:
 * - reuses or mints `X-Request-Id` / `X-Correlation-Id`;
 * - continues a valid inbound W3C `traceparent` or starts a trace id that an event
 *   consumer can rebuild from the correlation id;
 * - runs the rest of the request inside the AsyncLocalStorage trace scope, so every
 *   downstream log and span inherits the ids;
 * - returns the correlation ids and the active `traceparent` on the response.
 */
export function createHttpRequestLogging(service: string, destination?: pino.DestinationStream) {
  const logger = createServiceLogger(service, destination);
  return (request: ObservedRequest, response: ServerResponse, next: () => void): void => {
    const identity = resolveRequestContext(request.headers);
    const trace = resolveInboundTraceContext(request.headers, identity.correlationId);
    const context: RequestContext = { ...identity, trace };
    request.pssContext = context;
    // Identity is bound on the child logger; the trace ids come from the
    // AsyncLocalStorage scope so a line never carries two copies of the same field.
    request.pssLogger = logger.child(identity);
    response.setHeader('X-Request-Id', identity.requestId);
    response.setHeader('X-Correlation-Id', identity.correlationId);
    response.setHeader('traceparent', formatTraceparent(trace));
    if (trace.traceState) response.setHeader('tracestate', trace.traceState);

    const start = process.hrtime.bigint();
    response.once('finish', () => {
      // Re-enter the trace scope explicitly: the socket flush runs in whichever async
      // context ends the response, which is not necessarily the request's.
      runWithTraceContext(trace, () => {
        request.pssLogger?.info({
          method: request.method,
          statusCode: response.statusCode,
          durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
        }, 'HTTP request completed');
      });
    });
    runWithTraceContext(trace, next);
  };
}
