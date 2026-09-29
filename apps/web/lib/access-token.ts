/**
 * Shared with `middleware.ts` (Edge runtime) as well as `auth.ts` (Node/RSC runtime) — this file
 * must stay free of `next/headers`/`next/server` imports, which are not valid in both contexts.
 */
export interface StoredToken {
  accessToken?: string | undefined;
  expiresAt?: number | undefined;
  refreshToken?: string | undefined;
  error?: 'RefreshTokenError' | undefined;
}

const issuer = process.env.AUTH_KEYCLOAK_ISSUER;

export async function refreshAccessToken(token: StoredToken): Promise<StoredToken> {
  if (!issuer || !token.refreshToken) return { ...token, error: 'RefreshTokenError' };
  try {
    const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: 'no-store' });
    if (!discoveryResponse.ok) return { ...token, error: 'RefreshTokenError' };
    const discovery: unknown = await discoveryResponse.json();
    if (typeof discovery !== 'object' || discovery === null ||
        !('token_endpoint' in discovery) || typeof discovery.token_endpoint !== 'string') {
      return { ...token, error: 'RefreshTokenError' };
    }
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.AUTH_KEYCLOAK_ID ?? 'pss-web',
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      }),
      cache: 'no-store',
    });
    if (!response.ok) return { ...token, error: 'RefreshTokenError' };
    const refreshed: unknown = await response.json();
    if (typeof refreshed !== 'object' || refreshed === null ||
        !('access_token' in refreshed) || typeof refreshed.access_token !== 'string' ||
        !('expires_in' in refreshed) || typeof refreshed.expires_in !== 'number') {
      return { ...token, error: 'RefreshTokenError' };
    }
    return {
      ...token,
      accessToken: refreshed.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + refreshed.expires_in,
      refreshToken: 'refresh_token' in refreshed && typeof refreshed.refresh_token === 'string'
        ? refreshed.refresh_token : token.refreshToken,
      error: undefined,
    };
  } catch {
    return { ...token, error: 'RefreshTokenError' };
  }
}

/** True once a token is close enough to expiry that a caller should refresh before using it. */
export function isStoredTokenStale(token: StoredToken): boolean {
  return !token.expiresAt || Date.now() >= (token.expiresAt - 30) * 1000;
}
