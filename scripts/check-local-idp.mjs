const fetch = globalThis.fetch;
const issuer = process.env.PSS_LOCAL_OIDC_ISSUER ?? 'http://127.0.0.1:8080/realms/pss-local';
const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
if (!discoveryResponse.ok) throw new Error(`Local Keycloak discovery returned HTTP ${discoveryResponse.status}.`);
const discovery = await discoveryResponse.json();
if (discovery.issuer !== issuer) throw new Error('Local Keycloak issuer does not match the configured issuer.');
const jwksResponse = await fetch(discovery.jwks_uri);
if (!jwksResponse.ok || !(await jwksResponse.json()).keys?.length) throw new Error('Local Keycloak has no signing keys.');

const authorizationUrl = new URL(discovery.authorization_endpoint);
authorizationUrl.searchParams.set('client_id', 'pss-web');
authorizationUrl.searchParams.set('response_type', 'code');
authorizationUrl.searchParams.set('redirect_uri', 'http://localhost:3000/api/auth/callback/keycloak');
authorizationUrl.searchParams.set('scope', 'openid');
authorizationUrl.searchParams.set('state', 'pss-local-smoke');
const missingChallenge = await fetch(authorizationUrl, { redirect: 'manual' });
const errorLocation = missingChallenge.headers.get('location');
if (missingChallenge.status !== 302 || !errorLocation || new URL(errorLocation).searchParams.get('error') !== 'invalid_request') {
  throw new Error('Local Keycloak did not reject an authorization request without PKCE.');
}

authorizationUrl.searchParams.set('code_challenge_method', 'S256');
authorizationUrl.searchParams.set('code_challenge', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const challenged = await fetch(authorizationUrl, { redirect: 'manual' });
if (challenged.status !== 200) throw new Error(`Local Keycloak PKCE login returned HTTP ${challenged.status}.`);
process.stdout.write('Local Keycloak realm, JWKS, and S256 PKCE enforcement: OK.\n');
