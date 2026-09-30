import { Injectable } from '@nestjs/common';
import { createAccessTokenVerifier, InvalidAccessTokenError } from '@pss/auth-client';
import {
  CurrentUserPermissionsResponseSchema, CurrentUserResponseSchema, DomainError,
  type CurrentUserResponse,
} from '@pss/contracts';

@Injectable()
export class FinanceAuth {
  private readonly verify = process.env.PSS_OIDC_ISSUER && process.env.PSS_OIDC_AUDIENCE && process.env.PSS_OIDC_JWKS_URI
    ? createAccessTokenVerifier({
      issuer: process.env.PSS_OIDC_ISSUER,
      audience: process.env.PSS_OIDC_AUDIENCE,
      jwksUri: process.env.PSS_OIDC_JWKS_URI,
    }) : undefined;
  private readonly coreApi = process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000';

  /** Identity facts arrive through the core API, never through identity tables. */
  async require(authorization: string | undefined, permission: string | readonly string[]): Promise<CurrentUserResponse> {
    if (!authorization) throw new DomainError('UNAUTHENTICATED');
    if (!this.verify) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    try { await this.verify(authorization); }
    catch (error) {
      if (error instanceof InvalidAccessTokenError) throw new DomainError('UNAUTHENTICATED');
      throw new DomainError('DEPENDENCY_UNAVAILABLE');
    }
    let userResponse: Response, grantsResponse: Response;
    try {
      [userResponse, grantsResponse] = await Promise.all([
        fetch(new URL('/me', this.coreApi), { headers: { authorization }, signal: AbortSignal.timeout(5000) }),
        fetch(new URL('/me/permissions', this.coreApi), { headers: { authorization }, signal: AbortSignal.timeout(5000) }),
      ]);
    } catch { throw new DomainError('DEPENDENCY_UNAVAILABLE'); }
    if (userResponse.status === 401 || grantsResponse.status === 401) throw new DomainError('UNAUTHENTICATED');
    if (!userResponse.ok || !grantsResponse.ok) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    const user = CurrentUserResponseSchema.parse(await userResponse.json());
    const grants = CurrentUserPermissionsResponseSchema.parse(await grantsResponse.json());
    const accepted = Array.isArray(permission) ? permission : [permission];
    if (grants.userId !== user.id || !grants.grants.some((grant) =>
      accepted.includes(grant.permission) && (
        grant.scopeType === 'ORGANIZATION' && (grant.scopeId === null || grant.scopeId === user.organizationId)
        || grant.scopeType === 'BRANCH' && grant.scopeId === user.primaryBranchId
      ))) throw new DomainError('PERMISSION_DENIED');
    return user;
  }
}
