import { DomainError, type ExperienceShellView } from '@pss/contracts';
import { screensFor, workSections, type WorkScreen } from '../navigation/work-screens';
import { readIdentityGrants, readIdentitySelf, type UpstreamTransport } from './sources';

export type ShellOutcome = { kind: 'SIGNED_OUT' } | { kind: 'VIEW'; view: ExperienceShellView };

const approvals: WorkScreen = {
  key: 'persetujuan', label: 'Persetujuan', description: 'Permintaan yang menunggu keputusan Anda.',
  href: '/persetujuan', permission: null, section: 'hari-ini', icon: 'persetujuan',
};

/**
 * The app shell's navigation for the signed-in viewer, from the same identity reads as Beranda
 * (RBAC-003: consume identity's grants, do not rebuild them). One entry per screen address, so a
 * viewer who both sells and hands over goods sees /kasir once. If identity cannot be read, only the
 * screens open to everyone are listed and `incomplete` says so; a short menu is never presented as
 * "no access".
 */
export async function resolveShellView(transport: UpstreamTransport, accessToken: string | null): Promise<ShellOutcome> {
  if (!accessToken) return { kind: 'SIGNED_OUT' };
  let self: Awaited<ReturnType<typeof readIdentitySelf>>;
  let grants: Awaited<ReturnType<typeof readIdentityGrants>>;
  try {
    [self, grants] = await Promise.all([readIdentitySelf(transport, accessToken), readIdentityGrants(transport, accessToken)]);
  } catch (error) {
    // 401 is an ended session. Any other refusal leaves the page to show its own answer.
    if (error instanceof DomainError && error.code === 'UNAUTHENTICATED') return { kind: 'SIGNED_OUT' };
    return view('Pengguna', screensFor(new Set()), true);
  }
  if (self.state !== 'OK') return view('Pengguna', screensFor(new Set()), true);
  const permissions = new Set(grants.state === 'OK' ? grants.data.grants.map((grant) => grant.permission) : []);
  const screens = screensFor(permissions);
  // The approval inbox is open to anyone holding an approval permission (home-view's primary action).
  if ([...permissions].some((permission) => permission.endsWith('.approve'))) screens.splice(1, 0, approvals);
  return view(self.data.displayName, screens, grants.state !== 'OK');
}

function view(displayName: string, screens: readonly WorkScreen[], incomplete: boolean): ShellOutcome {
  const seenHref = new Set<string>();
  const sections = workSections
    .map((section) => ({
      key: section.key,
      label: section.label,
      items: screens
        .filter((screen) => screen.section === section.key)
        .filter((screen) => (seenHref.has(screen.href) ? false : (seenHref.add(screen.href), true)))
        .map(({ key, label, description, href, icon }) => ({ key, label, description, href, icon })),
    }))
    .filter((section) => section.items.length > 0);
  return { kind: 'VIEW', view: { view: 'shell', version: 1, viewer: { displayName }, sections, incomplete } };
}
