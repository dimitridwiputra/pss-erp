import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pino, { type Logger } from 'pino';

export type RequestContext = {
  requestId: string;
  correlationId: string;
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

export function resolveRequestContext(headers: Record<string, HeaderValue>): RequestContext {
  const requestId = safeIdentifier(headers['x-request-id']) ?? randomUUID();
  return {
    requestId,
    correlationId: safeIdentifier(headers['x-correlation-id']) ?? requestId,
  };
}

export function requestContextFrom(request: ObservedRequest): RequestContext {
  return request.pssContext ?? resolveRequestContext(request.headers);
}

export function createServiceLogger(service: string, destination?: pino.DestinationStream): Logger {
  return pino({
    base: {
      service,
      env: process.env.NODE_ENV ?? 'development',
      traceId: null,
      spanId: null,
      organizationId: null,
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (level) => ({ level }) },
    // HTTP logs contain only allow-listed metadata. Bodies, headers, and URL
    // query strings are never passed to the logger.
    level: process.env.LOG_LEVEL ?? 'info',
  }, destination);
}

export function createHttpRequestLogging(service: string, destination?: pino.DestinationStream) {
  const logger = createServiceLogger(service, destination);
  return (request: ObservedRequest, response: ServerResponse, next: () => void): void => {
    const context = resolveRequestContext(request.headers);
    request.pssContext = context;
    request.pssLogger = logger.child(context);
    response.setHeader('X-Request-Id', context.requestId);
    response.setHeader('X-Correlation-Id', context.correlationId);

    const start = process.hrtime.bigint();
    response.once('finish', () => {
      request.pssLogger?.info({
        method: request.method,
        statusCode: response.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
      }, 'HTTP request completed');
    });
    next();
  };
}
