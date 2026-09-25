import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { createProblemDetails, DomainError, type ErrorCode, type FieldError } from '@pss/contracts';
import { createServiceLogger, requestContextFrom, type ObservedRequest } from '@pss/observability';
import { ZodError } from 'zod';

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
  400: 'VALIDATION_FAILED',
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
  if (exception instanceof ZodError) {
    const fieldErrors: FieldError[] = exception.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    }));
    return new DomainError('VALIDATION_FAILED', [], fieldErrors);
  }
  if (exception instanceof HttpException) {
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
    const { requestId, correlationId } = requestContextFrom(request);
    const normalized = normalizeError(exception);
    if (!normalized) (request.pssLogger ?? this.fallbackLogger.child({ requestId, correlationId }))
      .error({ code: 'INTERNAL' }, 'Unhandled HTTP error');
    const problem = createProblemDetails(normalized, {
      requestId,
      correlationId,
      instance: (request.originalUrl ?? request.url ?? '/').split('?')[0] || '/',
    });
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-correlation-id', correlationId);
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}
