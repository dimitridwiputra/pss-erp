import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { createProblemDetails, DomainError, type ErrorCode, type FieldError } from '@pss/contracts';
import { ZodError } from 'zod';

type HttpRequest = {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
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

function safeHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

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
  private readonly logger = new Logger(ProblemExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<HttpRequest>();
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const requestId = safeHeader(request.headers['x-request-id']) ?? randomUUID();
    const correlationId = safeHeader(request.headers['x-correlation-id']) ?? requestId;
    const normalized = normalizeError(exception);
    if (!normalized) this.logger.error(`Unhandled error; requestId=${requestId}`);
    const problem = createProblemDetails(normalized, {
      requestId,
      correlationId,
      instance: (request.originalUrl ?? request.url ?? '/').split('?')[0] || '/',
    });
    response.setHeader('x-request-id', requestId);
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}
