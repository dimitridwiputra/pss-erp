import { describe, expect, it } from 'vitest';
import { CurrentUserNavigationResponseSchema, ExperienceHomeViewSchema } from '../packages/contracts/src/api';
import { experienceResponse, resolveHome } from '../apps/web/lib/experience/experience-handler';
import {
  IDENTITY_GRANTS_PATH, IDENTITY_NAVIGATION_PATH, IDENTITY_SELF_PATH,
  type UpstreamRead, type UpstreamTransport,
} from '../apps/web/lib/experience/sources';

const USER_ID = '019a0000-0000-7000-8000-000000000001';
const ORGANIZATION_ID = '019a0000-0000-7000-8000-000000000002';
const BRANCH_ID = '019a0000-0000-7000-8000-000000000003';
const self = { id: USER_ID, organizationId: ORGANIZATION_ID, primaryBranchId: BRANCH_ID, displayName: 'Admin PSS' };
const navigation = {
  apps: [{ app: 'admin', accessPermission: 'app.admin.access', label: 'Administrasi', items: [{ key: 'user', label: 'Pengguna' }] }],
  bottomNav: [{ key: 'admin', label: 'Administrasi', href: '/admin' }],
  bottomNavTrimmed: false,
};
const grants = { userId: USER_ID, grants: [{ permission: 'finance.journal.approve', scopeType: 'BRANCH', scopeId: BRANCH_ID }] };
const context = { accessToken: 'test-token', requestId: 'request-1', instance: '/api/experience/home', now: new Date('2026-09-30T02:00:00.000Z') };

function transportOf(responses: Record<string, Response>, reads: UpstreamRead[]): UpstreamTransport {
  return async (read) => {
    reads.push(read);
    const response = responses[read.path];
    if (!response) throw new Error(`Unexpected read: ${read.path}`);
    return response;
  };
}

describe('PLT-008 / RBAC-003 F0 home', () => {
  it('accepts the same navigation contract returned by identity', () => {
    expect(CurrentUserNavigationResponseSchema.parse(navigation).apps[0]?.label).toBe('Administrasi');
    expect(CurrentUserNavigationResponseSchema.safeParse({ ...navigation, bottomNav: [...navigation.bottomNav, ...navigation.bottomNav, ...navigation.bottomNav, ...navigation.bottomNav, ...navigation.bottomNav] }).success).toBe(false);
  });

  it('composes one view from server scoped reads, with one usable action', async () => {
    const reads: UpstreamRead[] = [];
    const outcome = await resolveHome({ ...context, transport: transportOf({
      [IDENTITY_SELF_PATH]: Response.json(self),
      [IDENTITY_NAVIGATION_PATH]: Response.json(navigation),
      [IDENTITY_GRANTS_PATH]: Response.json(grants),
    }, reads) });
    expect(outcome.kind).toBe('VIEW');
    if (outcome.kind !== 'VIEW') return;
    const view = ExperienceHomeViewSchema.parse(outcome.view);
    expect(view.products).toEqual([{ key: 'admin', label: 'Administrasi' }]);
    expect(view.primaryAction).toEqual({ label: 'Buka persetujuan', href: '/persetujuan' });
    expect(view.incomplete).toBe(false);
    expect(reads.map((read) => read.path).sort()).toEqual([IDENTITY_SELF_PATH, IDENTITY_NAVIGATION_PATH, IDENTITY_GRANTS_PATH].sort());
    expect(reads.every((read) => read.method === 'GET' && read.accessToken === 'test-token')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('finance.journal.approve');
  });

  it('marks failed navigation as unknown, never as an empty entitlement', async () => {
    const outcome = await resolveHome({ ...context, transport: transportOf({
      [IDENTITY_SELF_PATH]: Response.json(self),
      [IDENTITY_NAVIGATION_PATH]: new Response('unavailable', { status: 503 }),
      [IDENTITY_GRANTS_PATH]: Response.json(grants),
    }, []) });
    expect(outcome.kind).toBe('VIEW');
    if (outcome.kind !== 'VIEW') return;
    expect(outcome.view.products).toBeNull();
    expect(outcome.view.incomplete).toBe(true);
    expect(outcome.view.sources.find((source) => source.source === 'identityNavigation')).toMatchObject({ state: 'UNAVAILABLE' });
  });

  it('does not invent an approval action when grants cannot be read', async () => {
    const outcome = await resolveHome({ ...context, transport: transportOf({
      [IDENTITY_SELF_PATH]: Response.json(self),
      [IDENTITY_NAVIGATION_PATH]: Response.json(navigation),
      [IDENTITY_GRANTS_PATH]: new Response('unavailable', { status: 503 }),
    }, []) });
    expect(outcome.kind).toBe('VIEW');
    if (outcome.kind !== 'VIEW') return;
    expect(outcome.view.primaryAction).toBeNull();
    expect(outcome.view.incomplete).toBe(true);
  });

  it('rejects a missing or expired session before rendering an entitlement', async () => {
    const reads: UpstreamRead[] = [];
    const absent = await resolveHome({ ...context, accessToken: null, transport: transportOf({}, reads) });
    expect(absent.kind).toBe('PROBLEM');
    expect(reads).toEqual([]);
    const expired = await resolveHome({ ...context, transport: transportOf({
      [IDENTITY_SELF_PATH]: new Response('unauthorized', { status: 401 }),
      [IDENTITY_NAVIGATION_PATH]: Response.json(navigation),
      [IDENTITY_GRANTS_PATH]: Response.json(grants),
    }, []) });
    expect(expired.kind).toBe('PROBLEM');
    if (expired.kind !== 'PROBLEM') return;
    expect(expired.problem.code).toBe('UNAUTHENTICATED');
    expect(experienceResponse(expired, context.requestId).status).toBe(401);
  });
});
