import {
  CurrentUserPermissionsResponseSchema,
  CurrentUserResponseSchema,
  DomainError,
  ProblemDetailsSchema,
  type CurrentUserPermissionsResponse,
  type CurrentUserResponse,
} from '@pss/contracts';
import type { z } from 'zod';
import { PendingApprovalProjectionSchema, type ExperienceSourceName, type PendingApprovalProjection } from './contract';

/**
 * PLT-008 read side of the experience BFF.
 *
 * AGENTS.md §3.1 / PLT-008.R01: the BFF consumes domains only through their public
 * application interface. `apps/web` declares no database driver, so that interface is the
 * domain HTTP API; nothing here opens a connection, and `UpstreamRead.method` is the
 * literal `'GET'`, so a write is not expressible from this module (PLT-008.NC01).
 */
export interface UpstreamRead {
  readonly method: 'GET';
  readonly path: string;
  readonly accessToken: string;
}

export type UpstreamTransport = (read: UpstreamRead) => Promise<Response>;

export type SourceOutcome<T> =
  | { readonly source: ExperienceSourceName; readonly state: 'OK'; readonly data: T }
  | { readonly source: ExperienceSourceName; readonly state: 'UNAVAILABLE'; readonly problemCode: string };

/** RFC 9457 statuses that mean this caller cannot use the product at all. */
function hardFailure(response: Response): DomainError {
  if (response.status === 401) return new DomainError('UNAUTHENTICATED');
  if (response.status === 403) return new DomainError('PERMISSION_DENIED');
  return new DomainError('DEPENDENCY_UNAVAILABLE');
}

async function problemCodeOf(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = ProblemDetailsSchema.safeParse(payload);
  return parsed.success ? parsed.data.code : 'DEPENDENCY_UNAVAILABLE';
}

async function readSource<T>(
  source: ExperienceSourceName,
  transport: UpstreamTransport,
  accessToken: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<SourceOutcome<T>> {
  let response: Response;
  try {
    response = await transport({ method: 'GET', path, accessToken });
  } catch {
    // A transport fault becomes a reported unavailable source; it is never swallowed
    // into an empty result (AGENTS.md §3.7, PLT-008.E1).
    return { source, state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw hardFailure(response);
    return { source, state: 'UNAVAILABLE', problemCode: await problemCodeOf(response) };
  }
  const payload: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  // An unreadable payload is a source failure, not an empty list.
  if (!parsed.success) return { source, state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' };
  return { source, state: 'OK', data: parsed.data };
}

export const IDENTITY_SELF_PATH = '/me';
export const IDENTITY_GRANTS_PATH = '/me/permissions';
export const PLATFORM_APPROVAL_INBOX_PATH = '/platform/approvals/inbox';

export type IdentitySelf = CurrentUserResponse;
export type IdentityGrants = CurrentUserPermissionsResponse;

export function readIdentitySelf(transport: UpstreamTransport, accessToken: string): Promise<SourceOutcome<IdentitySelf>> {
  return readSource<IdentitySelf>('identitySelf', transport, accessToken, IDENTITY_SELF_PATH, CurrentUserResponseSchema);
}

export function readIdentityGrants(transport: UpstreamTransport, accessToken: string): Promise<SourceOutcome<IdentityGrants>> {
  return readSource<IdentityGrants>('identityGrants', transport, accessToken, IDENTITY_GRANTS_PATH, CurrentUserPermissionsResponseSchema);
}

export function readPlatformApprovalInbox(
  transport: UpstreamTransport,
  accessToken: string,
): Promise<SourceOutcome<PendingApprovalProjection[]>> {
  return readSource<PendingApprovalProjection[]>(
    'platformApprovalInbox', transport, accessToken, PLATFORM_APPROVAL_INBOX_PATH,
    PendingApprovalProjectionSchema.array(),
  );
}
