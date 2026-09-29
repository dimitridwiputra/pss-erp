import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { getToken } from 'next-auth/jwt';
import type { Session } from 'next-auth';
import { headers } from 'next/headers';
import { isStoredTokenStale, refreshAccessToken, type StoredToken } from './lib/access-token';

const issuer = process.env.AUTH_KEYCLOAK_ISSUER;
const apiBaseUrl = process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000';

interface PssAccount {
  id: string;
  displayName: string;
  organizationId: string;
}

interface PssGrant {
  permission: string;
  scopeType: string;
  scopeId: string | null;
}

interface PssSession {
  pssAccount?: PssAccount;
  grants?: PssGrant[];
  error?: 'RefreshTokenError' | 'PssAccessDenied' | undefined;
}

async function getPssAccount(accessToken: string): Promise<PssAccount | null> {
  const response = await fetch(`${apiBaseUrl}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (response.status >= 500) throw new Error('PSS identity service unavailable');
  if (!response.ok) return null;
  const account: unknown = await response.json();
  if (typeof account !== 'object' || account === null ||
      !('id' in account) || typeof account.id !== 'string' ||
      !('displayName' in account) || typeof account.displayName !== 'string' ||
      !('organizationId' in account) || typeof account.organizationId !== 'string') return null;
  return { id: account.id, displayName: account.displayName, organizationId: account.organizationId };
}

async function getPssGrants(accessToken: string): Promise<PssGrant[] | null> {
  const response = await fetch(`${apiBaseUrl}/me/permissions`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('grants' in body) || !Array.isArray(body.grants)) return null;
  if (!body.grants.every((grant): grant is PssGrant =>
    typeof grant === 'object' && grant !== null &&
    'permission' in grant && typeof grant.permission === 'string' &&
    'scopeType' in grant && typeof grant.scopeType === 'string' &&
    'scopeId' in grant && (grant.scopeId === null || typeof grant.scopeId === 'string'))) return null;
  return body.grants;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: issuer ? [Keycloak({
    issuer,
    clientId: process.env.AUTH_KEYCLOAK_ID ?? 'pss-web',
    client: { token_endpoint_auth_method: 'none' },
    checks: ['pkce', 'state'],
  })] : [],
  pages: { signIn: '/masuk', error: '/masuk' },
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  callbacks: {
    async signIn({ account }) {
      if (!account?.access_token) return false;
      try {
        return Boolean(await getPssAccount(account.access_token));
      } catch {
        return '/masuk?error=ServiceUnavailable';
      }
    },
    async jwt({ token, account }) {
      const stored = token as typeof token & StoredToken;
      if (account) {
        stored.accessToken = account.access_token;
        stored.expiresAt = account.expires_at;
        stored.refreshToken = account.refresh_token;
        stored.error = undefined;
        return stored;
      }
      if (stored.accessToken && !isStoredTokenStale(stored)) return stored;
      return { ...stored, ...await refreshAccessToken(stored) };
    },
    async session({ session, token }) {
      const stored = token as typeof token & StoredToken;
      const pssSession = session as Session & PssSession;
      pssSession.error = stored.error;
      if (stored.error || !stored.accessToken) return pssSession;
      let account: PssAccount | null;
      try {
        account = await getPssAccount(stored.accessToken);
      } catch {
        pssSession.error = 'PssAccessDenied';
        return pssSession;
      }
      if (!account) {
        pssSession.error = 'PssAccessDenied';
        return pssSession;
      }
      pssSession.pssAccount = account;
      const grants = await getPssGrants(stored.accessToken);
      if (!grants) {
        pssSession.error = 'PssAccessDenied';
        return pssSession;
      }
      pssSession.grants = grants;
      return pssSession;
    },
  },
});

export async function getPssSession(): Promise<(Session & PssSession) | null> {
  return await auth() as (Session & PssSession) | null;
}

/** Server-only API credential; never place this value in the browser session payload. */
export async function getPssServerAccessToken(): Promise<string | null> {
  const requestHeaders = await headers();
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  for (const cookieName of ['authjs.session-token', '__Secure-authjs.session-token']) {
    const token = await getToken({ req: { headers: requestHeaders }, secret, cookieName });
    const stored = token as (typeof token & StoredToken) | null;
    if (!stored?.accessToken || stored.error) continue;
    if (isStoredTokenStale(stored)) {
      const refreshed = await refreshAccessToken(stored);
      return refreshed.error ? null : refreshed.accessToken ?? null;
    }
    return stored.accessToken;
  }
  return null;
}
