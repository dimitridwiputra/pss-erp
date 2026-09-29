import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApprovalInboxViewSchema } from '../packages/contracts/src/api/experience-approval-inbox';
import { experienceResponse, resolveApprovalDetail, resolveApprovalInbox } from '../apps/web/lib/experience/experience-handler';
import { IDENTITY_GRANTS_PATH, IDENTITY_SELF_PATH, PLATFORM_APPROVAL_INBOX_PATH } from '../apps/web/lib/experience/sources';
import type { UpstreamRead, UpstreamTransport } from '../apps/web/lib/experience/sources';

const ORGANIZATION_ID = '019a0000-0000-7000-8000-0000000000a1';
const USER_ID = '019a0000-0000-7000-8000-0000000000a2';
const BRANCH_A = '019a0000-0000-7000-8000-0000000000b1';
const BRANCH_B = '019a0000-0000-7000-8000-0000000000b2';
const APPROVAL_A = '019a0000-0000-7000-8000-0000000000c1';
const APPROVAL_B = '019a0000-0000-7000-8000-0000000000c2';
const EXPIRES_AT = '2099-09-30T06:00:00.000Z';

const self = { id: USER_ID, organizationId: ORGANIZATION_ID, displayName: 'Admin Demo PSS', primaryBranchId: BRANCH_A };
const grants = {
  userId: USER_ID,
  grants: [{ permission: 'credit.override.approve', scopeType: 'BRANCH', scopeId: BRANCH_A }],
};
const projectionA = {
  id: APPROVAL_A, typeCode: 'credit_profile_change', summary: 'Override kredit · Toko Makmur · Rp 15 jt',
  amount: '15000000.00', branchId: BRANCH_A, expiresAt: EXPIRES_AT, requiredRole: 'BRANCH_MANAGER',
};
const projectionB = {
  id: APPROVAL_B, typeCode: 'stock_adjustment', summary: 'Penyesuaian stok · Gudang Amanah',
  amount: '725000.50', branchId: BRANCH_B, expiresAt: EXPIRES_AT, requiredRole: 'CONTROLLER',
};

type Upstream = Record<string, () => Response | Promise<Response>>;

function stubUpstream(upstream: Upstream): { transport: UpstreamTransport; reads: UpstreamRead[] } {
  const reads: UpstreamRead[] = [];
  const transport: UpstreamTransport = async (read) => {
    reads.push(read);
    const answer = upstream[read.path];
    if (!answer) throw new Error(`Unexpected upstream read ${read.path}`);
    return answer();
  };
  return { transport, reads };
}

const ok = (body: unknown) => () => Response.json(body);
const problem = (status: number, code: string) => () =>
  Response.json(
    { type: `/errors/${code}`, title: 'Gagal', status, detail: 'Gagal', instance: '/x', code, message: 'Gagal', requestId: 'r', correlationId: 'c', permittedActions: [], retryable: false },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const healthy = { [IDENTITY_SELF_PATH]: ok(self), [IDENTITY_GRANTS_PATH]: ok(grants), [PLATFORM_APPROVAL_INBOX_PATH]: ok([projectionA]) };
const context = { requestId: 'req-1', instance: '/api/experience/approvals', now: new Date('2026-09-29T02:00:00.000Z') };

describe('PLT-008 experience BFF — approval inbox', () => {
  it('APR-002.AC01 / PLT-008.AC01 returns one labelled, ready-to-render view', async () => {
    const { transport } = stubUpstream(healthy);
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    expect(outcome.kind).toBe('VIEW');
    if (outcome.kind !== 'VIEW') return;
    const view = ApprovalInboxViewSchema.parse(outcome.view);
    expect(view.items).toHaveLength(1);
    expect(view.items?.[0]?.status.label).toBe('Menunggu persetujuan Anda');
    expect(view.items?.[0]?.status.tone).toBe('warning');
    // `Intl` puts a non-breaking space between the currency and the digits.
    expect(view.items?.[0]?.amountLabel).toMatch(/^Rp\s15\.000\.000$/);
    expect(view.items?.[0]?.deadlineLabel).toMatch(/^Batas waktu /);
    expect(view.items?.[0]?.permittedActions).toEqual([
      { action: 'APPROVE', label: 'Setujui', requiresReason: true },
      { action: 'REJECT', label: 'Tolak', requiresReason: true },
    ]);
    expect(view.incomplete).toBe(false);
    expect(view.viewer).toEqual({ displayName: 'Admin Demo PSS', organizationId: ORGANIZATION_ID, canDecide: true });
  });

  it('PLT-008.AC04 / BR02 never returns a request outside the caller branch', async () => {
    const { transport } = stubUpstream({ ...healthy, [PLATFORM_APPROVAL_INBOX_PATH]: ok([projectionA]) });
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    const serialized = JSON.stringify(outcome.view);
    expect(outcome.view.items?.map((item) => item.approvalId)).toEqual([APPROVAL_A]);
    // Absent from the response, not merely hidden by the client.
    expect(serialized).not.toContain(projectionB.id);
    expect(serialized).not.toContain(projectionB.branchId);
    expect(serialized).not.toContain(projectionB.summary);
    expect(serialized).not.toContain('725000.50');
    // The upstream read is the only place scope can be enforced, and it ran first.
    expect(outcome.view.sources.find((source) => source.source === 'platformApprovalInbox')?.state).toBe('OK');
  });

  it('PLT-008.AC02 / UX-002.NC01 never ships a raw enum to the screen', async () => {
    const { transport } = stubUpstream(healthy);
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    const serialized = JSON.stringify(outcome.view);
    expect(serialized).not.toContain(projectionA.typeCode);
    expect(serialized).not.toContain(projectionA.requiredRole);
    expect(serialized).not.toContain('"PENDING"');
    expect(outcome.view.items?.[0]?.status).toMatchObject({ code: 'Q-APPROVAL_PENDING', known: true });
  });

  it('PLT-008.E1 / TS03 marks a failed source instead of returning a silently empty queue', async () => {
    const { transport } = stubUpstream({
      ...healthy, [PLATFORM_APPROVAL_INBOX_PATH]: problem(503, 'DEPENDENCY_UNAVAILABLE'),
    });
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    expect(outcome.view.items).toBeNull();
    expect(outcome.view.incomplete).toBe(true);
    expect(outcome.view.sources).toEqual([
      { source: 'identitySelf', state: 'OK' },
      { source: 'identityGrants', state: 'OK' },
      { source: 'platformApprovalInbox', state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE' },
    ]);
  });

  it('PLT-008.TS03 keeps the readable half and still says the response is partial', async () => {
    const { transport } = stubUpstream({ ...healthy, [IDENTITY_GRANTS_PATH]: problem(500, 'INTERNAL') });
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    expect(outcome.view.items).toHaveLength(1);
    expect(outcome.view.incomplete).toBe(true);
    // Without grants the entitlement hint is unknown, not optimistic.
    expect(outcome.view.viewer.canDecide).toBe(false);
    expect(outcome.view.sources[1]).toEqual({ source: 'identityGrants', state: 'UNAVAILABLE', problemCode: 'INTERNAL' });
  });

  it('PLT-008.TS03 treats an unreadable upstream payload as a failed source, not as no work', async () => {
    const { transport } = stubUpstream({ ...healthy, [PLATFORM_APPROVAL_INBOX_PATH]: ok([{ ...projectionA, amount: 'fifteen million' }]) });
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    expect(outcome.view.items).toBeNull();
    expect(outcome.view.incomplete).toBe(true);
  });

  it('answers an expired session with RFC 9457 instead of an empty inbox', async () => {
    const { transport } = stubUpstream({ ...healthy, [IDENTITY_SELF_PATH]: problem(401, 'UNAUTHENTICATED') });
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    expect(outcome.kind).toBe('PROBLEM');
    if (outcome.kind !== 'PROBLEM') return;
    expect(outcome.problem).toMatchObject({ code: 'UNAUTHENTICATED', status: 401, requestId: 'req-1' });
    const response = experienceResponse(outcome, 'req-1');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(JSON.stringify(await response.json())).not.toMatch(/at |\.ts:\d+/);
  });

  it('rejects a request with no session before it reaches any domain', async () => {
    const { transport, reads } = stubUpstream(healthy);
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: null });
    expect(outcome.kind).toBe('PROBLEM');
    expect(reads).toEqual([]);
  });

  it('fails the whole view when the caller cannot be identified', async () => {
    const { transport } = stubUpstream({ ...healthy, [IDENTITY_SELF_PATH]: problem(503, 'DEPENDENCY_UNAVAILABLE') });
    const outcome = await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    expect(outcome.kind).toBe('PROBLEM');
    if (outcome.kind !== 'PROBLEM') return;
    expect(outcome.problem.code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

describe('PLT-008 experience BFF — approval deep link', () => {
  const detailContext = { ...context, instance: '/api/experience/approvals/{approvalId}' };

  it('returns the labelled card for a request the caller may act on', async () => {
    const { transport } = stubUpstream(healthy);
    const outcome = await resolveApprovalDetail({ ...detailContext, transport, accessToken: 'token' }, APPROVAL_A);
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    expect(outcome.view.card.status.label).toBe('Menunggu persetujuan Anda');
    expect(outcome.view.card.permittedActions).toHaveLength(2);
  });

  it('RBAC-003.R02 answers a request outside the caller scope with the same problem as one that does not exist', async () => {
    const { transport } = stubUpstream(healthy);
    const foreign = await resolveApprovalDetail({ ...detailContext, transport, accessToken: 'token' }, APPROVAL_B);
    const missing = await resolveApprovalDetail({ ...detailContext, transport, accessToken: 'token' }, '019a0000-0000-7000-8000-0000000000ff');
    const malformed = await resolveApprovalDetail({ ...detailContext, transport, accessToken: 'token' }, 'not-a-uuid');
    expect([foreign, missing, malformed].map((outcome) => outcome.kind)).toEqual(['PROBLEM', 'PROBLEM', 'PROBLEM']);
    const bodies = await Promise.all([foreign, missing, malformed].map(async (outcome) =>
      JSON.stringify((outcome as { problem: unknown }).problem)));
    // Identical answers: the endpoint never discloses that a request exists elsewhere.
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
  });

  it('does not claim "no access" when the inbox read itself failed', async () => {
    const { transport } = stubUpstream({ ...healthy, [PLATFORM_APPROVAL_INBOX_PATH]: problem(503, 'DEPENDENCY_UNAVAILABLE') });
    const outcome = await resolveApprovalDetail({ ...detailContext, transport, accessToken: 'token' }, APPROVAL_A);
    expect(outcome.kind).toBe('PROBLEM');
    if (outcome.kind !== 'PROBLEM') return;
    expect(outcome.problem.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(outcome.problem.retryable).toBe(true);
  });
});

describe('PLT-008.NC01 the BFF cannot write', () => {
  it('issues only GET reads and never opens a database', async () => {
    const { transport, reads } = stubUpstream(healthy);
    await resolveApprovalInbox({ ...context, transport, accessToken: 'token' });
    expect(reads.map((read) => read.method)).toEqual(['GET', 'GET', 'GET']);
    expect([...reads.map((read) => read.path)].sort()).toEqual(
      [IDENTITY_GRANTS_PATH, IDENTITY_SELF_PATH, PLATFORM_APPROVAL_INBOX_PATH].sort(),
    );

    const directory = new URL('../apps/web/lib/experience/', import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = await readFile(new URL(name, directory), 'utf8');
      expect(source, `${name} must not import a database driver`).not.toMatch(/from '(pg|@prisma\/client|typeorm|mongoose)'/);
      expect(source, `${name} must not open a connection`).not.toMatch(/new (Pool|Client|PrismaClient)\b/);
      expect(source, `${name} must not issue a mutating HTTP method`).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(source, `${name} must not run SQL`).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\s+[a-z_]+\.[a-z_]/i);
    }
    const routes = new URL('../apps/web/app/api/experience/', import.meta.url);
    for (const name of await readdir(routes, { recursive: true })) {
      if (typeof name !== 'string' || !name.endsWith('route.ts')) continue;
      const source = await readFile(new URL(name, routes), 'utf8');
      expect(source, `${name} must only export GET`).not.toMatch(/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/);
    }
  });

  it('keeps the session token on the server and reads it through the shared helper', async () => {
    const route = await readFile(
      fileURLToPath(new URL('../apps/web/app/api/experience/approvals/route.ts', import.meta.url)), 'utf8');
    expect(route).toContain('getPssServerAccessToken');
    expect(route).not.toMatch(/headers\(\).*authorization/);
  });
});
