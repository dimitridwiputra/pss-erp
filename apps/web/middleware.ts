import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { isStoredTokenStale, refreshAccessToken, type StoredToken } from './lib/access-token';

/**
 * Client-side fetches (`gudangFetch`) call bare relative paths like `/wms/tasks`
 * with no `Authorization` header of their own — the NestJS API resolves the acting user purely
 * from that header (see `IdentityService.getCurrentUser`), never from a session cookie. This
 * middleware is the bridge: it reads the same NextAuth session JWT `getPssServerAccessToken`
 * reads in Server Components, and stamps the matching request with a `Bearer` token before
 * `next.config.ts`'s rewrite forwards it to the API. Matches only the API-call prefixes (see
 * `config.matcher`) — everything else (page routes, static assets) passes through untouched.
 */
export async function middleware(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.next();

  let accessToken: string | null = null;
  for (const cookieName of ['authjs.session-token', '__Secure-authjs.session-token']) {
    const token = await getToken({ req: request, secret, cookieName }) as (StoredToken | null);
    if (!token?.accessToken || token.error) continue;
    if (isStoredTokenStale(token)) {
      const refreshed = await refreshAccessToken(token);
      accessToken = refreshed.error ? null : (refreshed.accessToken ?? null);
    } else {
      accessToken = token.accessToken;
    }
    break;
  }

  if (!accessToken) return NextResponse.next();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('authorization', `Bearer ${accessToken}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/wms/:path+', '/gudang/:path+', '/me', '/me/:path+'],
};
