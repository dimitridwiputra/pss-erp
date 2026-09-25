import { describe, expect, it } from 'vitest';
import { createProblemDetails, DomainError, MalformedRequestError, ProblemDetailsSchema } from '../packages/contracts/src/api/problem';
import { ProblemExceptionFilter } from '../packages/http/src/problem-exception.filter';
import { ZodValidationPipe } from '../packages/http/src/zod-validation.pipe';
import { HealthResponseSchema } from '../packages/contracts/src/api/health';

const context = { requestId: 'req-1', correlationId: 'corr-1', instance: '/test' };

function invokeFilter(error: unknown, headers: Record<string, string> = {}, url = '/test?secret=hidden') {
  const result: { status?: number; contentType?: string; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const response = {
    setHeader(name: string, value: string) { result.headers[name] = value; },
    status(value: number) { result.status = value; return response; },
    type(value: string) { result.contentType = value; return response; },
    json(value: unknown) { result.body = value; },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers, originalUrl: url }),
      getResponse: () => response,
    }),
  };
  new ProblemExceptionFilter().catch(error, host as never);
  return result;
}

describe('PLT-007 problem response boundary', () => {
  it('maps registered segregation of duties errors to non-retryable Indonesian problem details', () => {
    const result = createProblemDetails(new DomainError('SEGREGATION_OF_DUTIES'), context);
    expect(result.status).toBe(403);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('petugas yang berbeda');
    expect(ProblemDetailsSchema.parse(result)).toEqual(result);
  });

  it('never sends an unknown exception message or stack to clients', () => {
    const error = new Error('private-account-123');
    const result = invokeFilter(error, { 'x-request-id': 'req_123', 'x-correlation-id': 'corr_123' });
    expect(result.status).toBe(500);
    expect(result.contentType).toBe('application/problem+json');
    expect(result.headers['x-request-id']).toBe('req_123');
    expect(result.headers['x-correlation-id']).toBe('corr_123');
    expect(result.body).toMatchObject({ code: 'INTERNAL', requestId: 'req_123', correlationId: 'corr_123', instance: '/test' });
    expect(JSON.stringify(result.body)).not.toContain('private-account-123');
    expect(JSON.stringify(result.body)).not.toContain('secret=hidden');
  });

  it('returns HTTP 400 with safe field paths for malformed requests', () => {
    const pipe = new ZodValidationPipe(HealthResponseSchema);
    let validation: unknown;
    try { pipe.transform({ status: 'invalid', service: 'api' }); } catch (error) { validation = error; }
    expect(validation).toBeInstanceOf(MalformedRequestError);
    const result = invokeFilter(validation);
    expect(result.status).toBe(400);
    expect(result.contentType).toBe('application/problem+json');
    expect(result.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: expect.arrayContaining([{ path: 'status', code: 'invalid_value', message: 'Periksa nilai ini.' }]),
      retryable: false,
    });
    expect(JSON.stringify(result.body)).not.toContain('expected');
  });

  it('keeps semantic validation at HTTP 422 with safe field paths', () => {
    const validation = ProblemDetailsSchema.safeParse({ status: 'invalid' });
    if (validation.success) throw new Error('Fixture must fail validation');
    const result = invokeFilter(new DomainError('VALIDATION_FAILED', [], [{ path: 'status', code: 'invalid_value', message: 'Periksa nilai ini.' }]));
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: expect.arrayContaining([{ path: 'status', code: 'invalid_value', message: 'Periksa nilai ini.' }]),
      retryable: false,
    });
    expect(invokeFilter(validation.error).status).toBe(500);
  });

  it('marks only transient registered errors as retryable', () => {
    expect(createProblemDetails(new DomainError('DEPENDENCY_UNAVAILABLE'), context).retryable).toBe(true);
    expect(createProblemDetails(new DomainError('RATE_LIMITED'), context).retryable).toBe(true);
    expect(createProblemDetails(new DomainError('STALE_DATA'), context).retryable).toBe(false);
  });
});
