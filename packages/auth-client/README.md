# @pss/auth-client

`createAccessTokenVerifier` verifies an IdP access token's RS256 signature through a cached JWKS, issuer, audience, expiry, and required subject/issued-at claims. It returns only the subject and token times. The owning `identity` domain must still resolve that subject to an active PSS account and its access assignments; a valid IdP token alone never authorizes a PSS command. The verifier is not yet wired to all deployables or a web OIDC login flow, so IDN-001 remains partial.
