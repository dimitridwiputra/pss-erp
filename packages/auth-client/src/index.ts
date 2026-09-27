import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AccessTokenVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
}

export interface VerifiedAccessToken {
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('Access token is missing or invalid.');
    this.name = 'InvalidAccessTokenError';
  }
}

/** Verify IdP signatures and claims locally; no password or token is logged or stored. */
export function createAccessTokenVerifier(options: AccessTokenVerifierOptions) {
  if (!options.issuer || !options.audience || !options.jwksUri) {
    throw new Error('OIDC issuer, audience, and JWKS URI are required.');
  }
  const jwksUrl = new URL(options.jwksUri);
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(jwksUrl.hostname);
  if (jwksUrl.protocol !== 'https:' && !(jwksUrl.protocol === 'http:' && localHost)) {
    throw new Error('OIDC JWKS URI must use HTTPS, except for local loopback development.');
  }
  const jwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 5000 });

  return async (authorizationHeader: string | undefined): Promise<VerifiedAccessToken> => {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorizationHeader ?? '');
    if (!match || authorizationHeader!.length > 8192) throw new InvalidAccessTokenError();
    try {
      const { payload } = await jwtVerify(match[1]!, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
      });
      if (!payload.sub || payload.iat === undefined || payload.exp === undefined) {
        throw new InvalidAccessTokenError();
      }
      return { subject: payload.sub, issuedAt: payload.iat, expiresAt: payload.exp };
    } catch {
      throw new InvalidAccessTokenError();
    }
  };
}
