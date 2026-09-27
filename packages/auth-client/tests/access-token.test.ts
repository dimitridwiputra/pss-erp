import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createAccessTokenVerifier, InvalidAccessTokenError } from '../src';

const issuer = 'http://localhost/realms/pss-test';
const audience = 'pss-api';
let server: Server;
let jwksUri: string;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;

async function token(options: {
  audience?: string;
  privateKey?: CryptoKey;
  expiresAt?: string;
  includeIssuedAt?: boolean;
} = {}): Promise<string> {
  let jwt = new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
    .setIssuer(issuer)
    .setAudience(options.audience ?? audience)
    .setSubject('idp-subject-1');
  if (options.includeIssuedAt !== false) jwt = jwt.setIssuedAt();
  if (options.expiresAt) jwt = jwt.setExpirationTime(options.expiresAt);
  else jwt = jwt.setExpirationTime('5m');
  return jwt.sign(options.privateKey ?? signingKey);
}

beforeAll(async () => {
  const primary = await generateKeyPair('RS256');
  const secondary = await generateKeyPair('RS256');
  signingKey = primary.privateKey;
  otherKey = secondary.privateKey;
  publicJwk = { ...await exportJWK(primary.publicKey), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test JWKS server did not bind.');
  jwksUri = `http://127.0.0.1:${address.port}/jwks`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('IDN-001 local JWKS access-token verification', () => {
  it('accepts a signed token for the configured issuer and audience', async () => {
    const verify = createAccessTokenVerifier({ issuer, audience, jwksUri });
    const result = await verify(`Bearer ${await token()}`);
    expect(result.subject).toBe('idp-subject-1');
    expect(result.expiresAt).toBeGreaterThan(result.issuedAt);
    expect((await verify(`bearer ${await token()}`)).subject).toBe('idp-subject-1');
  });

  it('rejects expiration, audience mismatch, bad signature, and missing claims', async () => {
    const verify = createAccessTokenVerifier({ issuer, audience, jwksUri });
    for (const candidate of [
      await token({ expiresAt: '1s ago' }),
      await token({ audience: 'another-api' }),
      await token({ privateKey: otherKey }),
      await token({ includeIssuedAt: false }),
    ]) {
      await expect(verify(`Bearer ${candidate}`)).rejects.toBeInstanceOf(InvalidAccessTokenError);
    }
    await expect(verify(undefined)).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(verify('Bearer not.a.jwt')).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(verify(`Bearer ${'a'.repeat(8192)}`)).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it('rejects a non-network JWKS URI at configuration time', () => {
    expect(() => createAccessTokenVerifier({ issuer, audience, jwksUri: 'file:///tmp/keys.json' }))
      .toThrow('must use HTTPS');
    expect(() => createAccessTokenVerifier({ issuer, audience, jwksUri: 'http://remote.example/jwks' }))
      .toThrow('must use HTTPS');
  });
});
