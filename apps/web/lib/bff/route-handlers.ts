import { randomUUID } from 'node:crypto';
import { getPssServerAccessToken } from '../../auth';
import { proxyToUpstream, type BffUpstream } from './proxy';

interface CatchAllContext { params: Promise<{ path?: string[] }> }

/** The five verbs the proxy serves for one upstream, for `app/api/bff/<upstream>/[...path]/route.ts`. */
export function bffRouteHandlers(upstream: BffUpstream) {
  const handle = async (request: Request, context: CatchAllContext): Promise<Response> => proxyToUpstream({
    request,
    upstream,
    pathSegments: (await context.params).path ?? [],
    accessToken: await getPssServerAccessToken(),
    requestId: request.headers.get('x-request-id') ?? randomUUID(),
  });
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}
