import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsSchema } from '../packages/contracts/src/api';
import { proxyToUpstream, type BffProxyRequest } from '../apps/web/lib/bff/proxy';

interface Captured { url: string; init: RequestInit }

function fakeFetch(captured: Captured[], response: () => Response = () => Response.json({ ok: true })) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return response();
  }) as unknown as typeof fetch;
}

function call(overrides: Partial<BffProxyRequest> & { request: Request }, captured: Captured[], response?: () => Response) {
  return proxyToUpstream({
    upstream: 'core',
    pathSegments: ['pos', 'shifts'],
    accessToken: 'session-access-token',
    requestId: 'request-1',
    fetchImpl: fakeFetch(captured, response),
    ...overrides,
  });
}

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = ProblemDetailsSchema.parse(await response.json());
  expect(body.code).toBe(code);
}

describe('Web BFF proxy (MVP_PLAN §6.1, AGENTS.md §15)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('routes core and finance to their own base URLs, keeping the query string', async () => {
    vi.stubEnv('PSS_API_BASE_URL', 'http://core.internal:4000');
    vi.stubEnv('PSS_FINANCE_API_BASE_URL', 'http://finance.internal:4001');
    const captured: Captured[] = [];
    await call({ request: new Request('http://web.local/api/bff/core/pos/sales?page=2') , pathSegments: ['pos', 'sales'] }, captured);
    await call({ request: new Request('http://web.local/api/bff/finance/journals'), upstream: 'finance', pathSegments: ['journals'] }, captured);
    expect(captured.map(({ url }) => url)).toEqual([
      'http://core.internal:4000/pos/sales?page=2',
      'http://finance.internal:4001/journals',
    ]);
  });

  it('attaches the session token and passes Idempotency-Key through, but never the caller’s cookie or authorization', async () => {
    const captured: Captured[] = [];
    const request = new Request('http://web.local/api/bff/core/pos/shifts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'key-123',
        cookie: 'authjs.session-token=secret-cookie',
        authorization: 'Bearer attacker-supplied',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ terminalId: 'x' }),
    });
    await call({ request }, captured);
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer session-access-token');
    expect(headers.get('idempotency-key')).toBe('key-123');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-request-id')).toBe('request-1');
    expect(new TextDecoder().decode(captured[0]?.init.body as ArrayBuffer)).toBe('{"terminalId":"x"}');
  });

  it('never returns the token or upstream cookies to the browser', async () => {
    const captured: Captured[] = [];
    const response = await call({ request: new Request('http://web.local/api/bff/core/pos/shifts') }, captured, () =>
      new Response('{"id":"s1"}', { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'upstream=1', authorization: 'Bearer x' } }));
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('authorization')).toBeNull();
    expect(await response.text()).not.toContain('session-access-token');
  });

  it('passes upstream problem responses through with their status', async () => {
    const captured: Captured[] = [];
    const upstreamProblem = { code: 'PERMISSION_DENIED', status: 403 };
    const response = await call({ request: new Request('http://web.local/api/bff/core/pos/shifts') }, captured, () =>
      Response.json(upstreamProblem, { status: 403, headers: { 'content-type': 'application/problem+json' } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(upstreamProblem);
  });

  it('answers 401 without calling upstream when there is no session', async () => {
    const captured: Captured[] = [];
    await expectProblem(await call({ request: new Request('http://web.local/api/bff/core/pos/shifts'), accessToken: null }, captured), 401, 'UNAUTHENTICATED');
    expect(captured).toHaveLength(0);
  });

  it('refuses a cross-site mutation that would ride the session cookie', async () => {
    const captured: Captured[] = [];
    const request = new Request('http://web.local/api/bff/core/pos/shifts', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' });
    await expectProblem(await call({ request }, captured), 403, 'PERMISSION_DENIED');
    expect(captured).toHaveLength(0);
  });

  it.each([[['..', 'admin']], [['pos', '.']], [['pos/../admin']], [[]]])('rejects an unsafe path %j', async (pathSegments) => {
    const captured: Captured[] = [];
    await expectProblem(await call({ request: new Request('http://web.local/api/bff/core/x'), pathSegments }, captured), 404, 'NOT_FOUND');
    expect(captured).toHaveLength(0);
  });

  it('reports an unreachable upstream as a retryable 503, not a stack trace', async () => {
    const response = await proxyToUpstream({
      request: new Request('http://web.local/api/bff/core/pos/shifts'),
      upstream: 'core', pathSegments: ['pos', 'shifts'], accessToken: 't', requestId: 'r',
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
    });
    await expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('does not let the browser follow an upstream redirect', async () => {
    const captured: Captured[] = [];
    const response = await call({ request: new Request('http://web.local/api/bff/core/pos/shifts') }, captured, () =>
      new Response(null, { status: 302, headers: { location: 'http://core.internal:4000/elsewhere' } }));
    expect(response.headers.get('location')).toBeNull();
    await expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
  });
});
