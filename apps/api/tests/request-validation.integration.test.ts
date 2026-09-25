import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory, type INestApplication } from '@nestjs/core';
import { HealthResponseSchema, DomainError, type HealthResponse } from '@pss/contracts';
import { ProblemExceptionFilter, ZodValidationPipe } from '@pss/http';

@Controller('validation-probe')
class ValidationProbeController {
  @Post()
  accept(@Body(new ZodValidationPipe(HealthResponseSchema)) body: HealthResponse): HealthResponse {
    return body;
  }

  @Post('semantic')
  reject(): never {
    throw new DomainError('VALIDATION_FAILED', [], [{ path: 'service', code: 'not_allowed', message: 'Periksa nilai ini.' }]);
  }
}

@Module({ controllers: [ValidationProbeController] })
class ValidationProbeModule {}

describe('PLT-003 API request boundary', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(ValidationProbeModule, { logger: false });
    app.useGlobalFilters(new ProblemExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => { await app?.close(); });

  it('returns 400 problem+json and a safe field path for malformed JSON fields', async () => {
    const response = await fetch(`${baseUrl}/validation-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'invalid', service: 'api' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await response.json();
    expect(body).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, fieldErrors: [{ path: 'status', code: 'invalid_value', message: 'Periksa nilai ini.' }] });
    expect(body.requestId).toBeTruthy();
    expect(body.correlationId).toBeTruthy();
  });

  it('keeps domain validation at 422', async () => {
    const response = await fetch(`${baseUrl}/validation-probe/semantic`, { method: 'POST' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });
});
