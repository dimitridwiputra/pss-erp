import type { ExperienceHomeView } from '@pss/contracts';
import { sourceReport } from './approval-view';
import type { IdentityGrants, IdentityNavigation, IdentitySelf, SourceOutcome } from './sources';

/** RBAC-003: consume the identity service's entitlement decision; do not rebuild it in UI. */
export function buildHomeView(input: {
  self: IdentitySelf;
  navigation: SourceOutcome<IdentityNavigation>;
  grants: SourceOutcome<IdentityGrants>;
  generatedAt: Date;
}): ExperienceHomeView {
  const sources = [
    sourceReport({ source: 'identitySelf', state: 'OK', data: input.self }),
    sourceReport(input.navigation),
    sourceReport(input.grants),
  ];
  const canApprove = input.grants.state === 'OK' &&
    input.grants.data.grants.some((grant) => grant.permission.endsWith('.approve'));
  return {
    view: 'home',
    version: 1,
    viewer: { displayName: input.self.displayName },
    // An unavailable navigation read must never be displayed as "no product access".
    products: input.navigation.state === 'OK'
      ? input.navigation.data.apps.map(({ app, label }) => ({ key: app, label }))
      : null,
    // Approval is the only F0 work surface ready for general navigation. F9 WMS and
    // F11 POS code existing locally does not make their release gates complete.
    primaryAction: canApprove ? { label: 'Buka persetujuan', href: '/persetujuan' } : null,
    sources,
    incomplete: sources.some((source) => source.state === 'UNAVAILABLE'),
    generatedAt: input.generatedAt.toISOString(),
  };
}
