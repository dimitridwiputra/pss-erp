import { createProblemDetails, DomainError } from '@pss/contracts';

/**
 * The browser's only path to `apps/api` and `apps/finance-api` (MVP_PLAN §6.1). Client code calls
 * `/api/bff/core/*` or `/api/bff/finance/*` with its session cookie; this function swaps the cookie
 * for the session's access token on the server, so the token never reaches the browser
 * (AGENTS.md §15) and each upstream still resolves and authorizes the acting user itself.
 *
 * It is framework-agnostic on purpose, like `lib/experience/experience-handler.ts`: the route
 * handlers under `app/api/bff/**` only add the session token.
 */

export type BffUpstream = 'core' | 'finance';

const upstreamBaseUrl: Record<BffUpstream, () => string> = {
  core: () => process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000',
  finance: () => process.env.PSS_FINANCE_API_BASE_URL ?? 'http://127.0.0.1:4001',
};

// Allow-lists, not deny-lists: `cookie` and the caller's own `authorization` must never pass.
const forwardedRequestHeaders = [
  'accept', 'accept-language', 'content-type', 'idempotency-key', 'if-match', 'if-none-match', 'x-correlation-id',
] as const;
const forwardedResponseHeaders = [
  'cache-control', 'content-disposition', 'content-type', 'etag', 'retry-after', 'x-correlation-id', 'x-request-id',
] as const;

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const upstreamTimeoutMs = 15_000;

export interface BffProxyRequest {
  readonly request: Request;
  readonly upstream: BffUpstream;
  readonly pathSegments: readonly string[];
  readonly accessToken: string | null;
  readonly requestId: string;
  readonly fetchImpl?: typeof fetch;
}

function problemResponse(error: DomainError, context: { requestId: string; correlationId: string; instance: string }): Response {
  const problem = createProblemDetails(error, context);
  return Response.json(problem, {
    status: problem.status,
    headers: {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
      'x-request-id': problem.requestId,
      'x-correlation-id': problem.correlationId,
    },
  });
}

/** A decoded segment that could climb out of the upstream prefix or smuggle a second path. */
function isUnsafeSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || /[/\\?#]/.test(segment);
}

export async function proxyToUpstream(input: BffProxyRequest): Promise<Response> {
  const { request, upstream, pathSegments, accessToken, requestId } = input;
  const correlationId = request.headers.get('x-correlation-id') ?? requestId;
  const instance = new URL(request.url).pathname;
  const context = { requestId, correlationId, instance };

  if (pathSegments.length === 0 || pathSegments.some(isUnsafeSegment)) {
    return problemResponse(new DomainError('NOT_FOUND'), context);
  }
  // The session cookie now authenticates mutations, so a cross-site page must not be able to
  // ride it. Browsers send Sec-Fetch-Site on every request; a non-browser caller has no cookie.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (unsafeMethods.has(request.method) && fetchSite !== null && fetchSite !== 'same-origin') {
    return problemResponse(new DomainError('PERMISSION_DENIED'), context);
  }
  if (!accessToken) return problemResponse(new DomainError('UNAUTHENTICATED'), context);

  const headers = new Headers();
  for (const name of forwardedRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${accessToken}`);
  headers.set('x-request-id', requestId);
  headers.set('x-correlation-id', correlationId);

  const search = new URL(request.url).search;
  const target = `${upstreamBaseUrl[upstream]()}/${pathSegments.map(encodeURIComponent).join('/')}${search}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstreamResponse: Response;
  try {
    upstreamResponse = await (input.fetchImpl ?? fetch)(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : null,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    });
  } catch {
    return problemResponse(new DomainError('DEPENDENCY_UNAVAILABLE'), context);
  }

  const responseHeaders = new Headers();
  for (const name of forwardedResponseHeaders) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has('cache-control')) responseHeaders.set('cache-control', 'no-store');
  if (!responseHeaders.has('x-request-id')) responseHeaders.set('x-request-id', requestId);

  // An upstream redirect would point at the upstream's own origin; the browser must not follow it.
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    return problemResponse(new DomainError('DEPENDENCY_UNAVAILABLE'), context);
  }
  const nullBody = upstreamResponse.status === 204 || upstreamResponse.status === 304;
  return new Response(nullBody ? null : upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders });
}
