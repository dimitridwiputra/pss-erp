import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '../packages/http/src/zod-validation.pipe';
import { HealthResponseSchema } from '../packages/contracts/src/api/health';

const requestSchema = HealthResponseSchema;

describe('PLT-003 request validation boundary', () => {
  it('returns the canonical parsed request value', () => {
    expect(new ZodValidationPipe(requestSchema).transform({ status: 'ok', service: 'api' })).toEqual({ status: 'ok', service: 'api' });
  });

  it('rejects malformed, missing, and unexpected request fields', () => {
    const pipe = new ZodValidationPipe(requestSchema);
    expect(() => pipe.transform({ status: 'bad', service: 'api' })).toThrow();
    expect(() => pipe.transform({})).toThrow();
    expect(() => pipe.transform({ status: 'ok', service: 'api', extra: true })).toThrow();
  });
});
