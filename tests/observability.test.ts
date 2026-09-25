import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpRequestLogging, resolveRequestContext } from '../packages/observability/src/http-request-logging';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('OBS-001 HTTP request logging', () => {
  it('reuses safe identifiers and replaces malformed or array-valued headers', () => {
    expect(resolveRequestContext({ 'x-request-id': 'req_123', 'x-correlation-id': 'corr_123' }))
      .toEqual({ requestId: 'req_123', correlationId: 'corr_123' });
    const generated = resolveRequestContext({ 'x-request-id': 'bad id', 'x-correlation-id': ['a', 'b'] });
    expect(generated.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.correlationId).toBe(generated.requestId);
    expect(resolveRequestContext({ 'x-request-id': '3174010101010001' }).requestId)
      .not.toBe('3174010101010001');
  });

  it('returns identifiers on a successful response and logs only allow-listed HTTP metadata', async () => {
    const lines: string[] = [];
    const middleware = createHttpRequestLogging('api', { write: (line: string) => { lines.push(line); } });
    const server = createServer((request, response) => {
      middleware(request, response, () => { request.resume(); response.end('ok'); });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port.');

    const response = await fetch(`http://127.0.0.1:${address.port}/health/live?nik=3174010101010001`, {
      headers: {
        'x-request-id': 'req_123',
        'x-correlation-id': 'corr_456',
        authorization: 'Bearer secret-fixture',
        'x-customer-phone': '081234567890',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req_123');
    expect(response.headers.get('x-correlation-id')).toBe('corr_456');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lines).toHaveLength(1);
    const log = JSON.parse(lines[0] ?? '{}');
    expect(log).toMatchObject({
      level: 'info', service: 'api', requestId: 'req_123', correlationId: 'corr_456',
      method: 'GET', statusCode: 200, msg: 'HTTP request completed',
    });
    expect(log.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    const output = lines.join('');
    expect(output).not.toContain('3174010101010001');
    expect(output).not.toContain('081234567890');
    expect(output).not.toContain('secret-fixture');
    expect(output).not.toContain('/health/live?');
  });
});
