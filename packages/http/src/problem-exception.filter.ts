import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { createProblemDetails, DomainError, MalformedRequestError, type ErrorCode } from '@pss/contracts';
import {
  createServiceLogger,
  formatTraceparent,
  requestContextFrom,
  runWithTraceContext,
  type ObservedRequest,
} from '@pss/observability';

type HttpRequest = ObservedRequest & {
  originalUrl?: string;
};

type HttpResponse = {
  setHeader(name: string, value: string): void;
  status(status: number): HttpResponse;
  type(contentType: string): HttpResponse;
  json(body: unknown): void;
};

const httpCodeByStatus: Record<number, ErrorCode> = {
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'STALE_DATA',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'DEPENDENCY_UNAVAILABLE',
};

function normalizeError(exception: unknown): DomainError | undefined {
  if (exception instanceof DomainError) return exception;
  if (exception instanceof HttpException) {
    if (exception.getStatus() === 400) {
      return new MalformedRequestError([{ path: 'input', code: 'invalid_format', message: 'Periksa format permintaan.' }]);
    }
    const code = httpCodeByStatus[exception.getStatus()];
    return code ? new DomainError(code) : undefined;
  }
  return undefined;
}

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  private readonly fallbackLogger = createServiceLogger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<HttpRequest>();
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { requestId, correlationId, trace } = requestContextFrom(request);
    const normalized = normalizeError(exception);
    // The exception filter can run outside the request's trace scope (a filter is
    // invoked from the exception layer, not the middleware), so the ids are bound
    // explicitly rather than inherited.
    if (!normalized) runWithTraceContext(trace, () => {
      (request.pssLogger ?? this.fallbackLogger.child({ requestId, correlationId }))
        .error({ code: 'INTERNAL' }, 'Unhandled HTTP error');
    });
    const problem = createProblemDetails(normalized, {
      requestId,
      correlationId,
      instance: (request.originalUrl ?? request.url ?? '/').split('?')[0] || '/',
    });
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-correlation-id', correlationId);
    response.setHeader('traceparent', formatTraceparent(trace));
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}
