import { Controller, Get, Inject, Injectable, OnModuleDestroy, Req } from '@nestjs/common';
import { createAccessTokenVerifier, InvalidAccessTokenError } from '@pss/auth-client';
import { CurrentUserResponseSchema, CurrentUserPermissionsResponseSchema, DomainError, type CurrentUserResponse, type CurrentUserPermissionsResponse } from '@pss/contracts';
import { loadActiveRoleAssignments, resolveActiveUser, resolveRolePermissions } from '@pss/identity';
import { Pool } from 'pg';

@Injectable()
export class IdentityService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;
  private readonly verify = process.env.PSS_OIDC_ISSUER && process.env.PSS_OIDC_AUDIENCE && process.env.PSS_OIDC_JWKS_URI
    ? createAccessTokenVerifier({
      issuer: process.env.PSS_OIDC_ISSUER,
      audience: process.env.PSS_OIDC_AUDIENCE,
      jwksUri: process.env.PSS_OIDC_JWKS_URI,
    })
    : undefined;

  async getCurrentUser(authorizationHeader: string | undefined): Promise<CurrentUserResponse> {
    if (!authorizationHeader) throw new DomainError('UNAUTHENTICATED');
    if (!this.verify || !this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    try {
      const token = await this.verify(authorizationHeader);
      return CurrentUserResponseSchema.parse(await resolveActiveUser(this.pool, token.subject));
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw new DomainError('UNAUTHENTICATED');
      if (error instanceof DomainError) throw error;
      throw new DomainError('DEPENDENCY_UNAVAILABLE');
    }
  }

  async getCurrentUserPermissions(authorizationHeader: string | undefined): Promise<CurrentUserPermissionsResponse> {
    const user = await this.getCurrentUser(authorizationHeader);
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    const assignments = await loadActiveRoleAssignments(this.pool, user.id);
    const grants = assignments.flatMap((assignment) =>
      resolveRolePermissions(assignment.roleCode).permissions.map((permission) => ({
        permission,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
      })));
    return CurrentUserPermissionsResponseSchema.parse({ userId: user.id, grants });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Controller('me')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get()
  getCurrentUser(@Req() request: { headers: { authorization?: string } }): Promise<CurrentUserResponse> {
    return this.identity.getCurrentUser(request.headers.authorization);
  }

  @Get('permissions')
  getCurrentUserPermissions(@Req() request: { headers: { authorization?: string } }): Promise<CurrentUserPermissionsResponse> {
    return this.identity.getCurrentUserPermissions(request.headers.authorization);
  }
}
