import { describe, expect, it } from 'vitest';
import { ExperienceShellViewSchema } from '../packages/contracts/src/api';
import { resolveShellView } from '../apps/web/lib/experience/shell-view';
import { IDENTITY_GRANTS_PATH, IDENTITY_SELF_PATH, type UpstreamTransport } from '../apps/web/lib/experience/sources';
import { workScreens } from '../apps/web/lib/navigation/work-screens';
import { shellIcons } from '../apps/web/app/_shell/icons';

const USER_ID = '019a0000-0000-7000-8000-000000000001';
const ORGANIZATION_ID = '019a0000-0000-7000-8000-000000000002';
const SCOPE_ID = '019a0000-0000-7000-8000-000000000003';
const self = { id: USER_ID, organizationId: ORGANIZATION_ID, primaryBranchId: SCOPE_ID, displayName: 'Admin Demo' };

function grantsOf(...permissions: string[]) {
  return { userId: USER_ID, grants: permissions.map((permission) => ({ permission, scopeType: 'WAREHOUSE', scopeId: SCOPE_ID })) };
}

function transport(responses: Record<string, () => Response>): UpstreamTransport {
  return async (read) => {
    const response = responses[read.path];
    if (!response) throw new Error(`Unexpected read: ${read.path}`);
    return response();
  };
}

async function sectionsFor(...permissions: string[]) {
  const outcome = await resolveShellView(transport({
    [IDENTITY_SELF_PATH]: () => Response.json(self),
    [IDENTITY_GRANTS_PATH]: () => Response.json(grantsOf(...permissions)),
  }), 'token');
  if (outcome.kind !== 'VIEW') throw new Error('expected a view');
  return ExperienceShellViewSchema.parse(outcome.view);
}

describe('App shell navigation (DESIGN_SYSTEM §7, RBAC-003)', () => {
  it('lists only permitted screens, grouped by work, with Beranda for everyone', async () => {
    const view = await sectionsFor('pos.report.view', 'payments.cash_custody.verify');
    expect(view.viewer.displayName).toBe('Admin Demo');
    expect(view.sections.map((section) => [section.label, section.items.map((item) => item.href)])).toEqual([
      ['Hari Ini', ['/beranda']],
      ['Penjualan', ['/kantor/penjualan']],
      ['Kas', ['/kantor/setoran-kas']],
    ]);
    expect(JSON.stringify(view)).not.toContain('pos.report.view');
  });

  it('shows /kasir once to someone who both sells and hands over goods', async () => {
    const view = await sectionsFor('pos.shift.open', 'fulfillment.pickup.handover');
    const penjualan = view.sections.find((section) => section.key === 'penjualan');
    expect(penjualan?.items.map((item) => item.label)).toEqual(['Kasir']);
  });

  it('adds Persetujuan for an approver, and nothing else from an approval grant', async () => {
    const view = await sectionsFor('finance.journal.approve');
    expect(view.sections).toEqual([expect.objectContaining({ label: 'Hari Ini', items: [expect.objectContaining({ href: '/beranda' }), expect.objectContaining({ href: '/persetujuan' })] })]);
  });

  it('marks the menu incomplete when grants cannot be read, instead of "no access"', async () => {
    const outcome = await resolveShellView(transport({
      [IDENTITY_SELF_PATH]: () => Response.json(self),
      [IDENTITY_GRANTS_PATH]: () => new Response('unavailable', { status: 503 }),
    }), 'token');
    expect(outcome).toMatchObject({ kind: 'VIEW', view: { incomplete: true, sections: [{ key: 'hari-ini' }] } });
  });

  it('treats a missing or refused session as signed out', async () => {
    expect(await resolveShellView(transport({}), null)).toEqual({ kind: 'SIGNED_OUT' });
    const refused = await resolveShellView(transport({
      [IDENTITY_SELF_PATH]: () => new Response('{}', { status: 401 }),
      [IDENTITY_GRANTS_PATH]: () => new Response('{}', { status: 401 }),
    }), 'expired');
    expect(refused).toEqual({ kind: 'SIGNED_OUT' });
  });

  it('gives every registered screen a known icon and a unique key', () => {
    expect(new Set(workScreens.map((screen) => screen.key)).size).toBe(workScreens.length);
    for (const screen of workScreens) expect(shellIcons, screen.key).toHaveProperty([screen.icon]);
    expect(shellIcons).toHaveProperty(['persetujuan']);
  });
});
