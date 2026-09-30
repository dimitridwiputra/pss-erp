import type { ExperienceHomeView } from '@pss/contracts';
import { sourceReport } from './approval-view';
import type { IdentityGrants, IdentityNavigation, IdentitySelf, SourceOutcome } from './sources';

/**
 * MVP work screens, each shown only to someone holding its permission somewhere (the screen and
 * the API still check scope on every record). The POS screens answer FEATURE_DISABLED when the
 * demo switch is off (MVP-OD-5). Another stream adds its screen here once its route exists.
 */
const workTileDefinitions = [
  { key: 'kasir', label: 'Kasir', description: 'Buka shift dan layani pembeli di konter.', href: '/kasir', permission: 'pos.shift.open' },
  { key: 'serah-barang', label: 'Serah Barang', description: 'Serahkan barang yang sudah dibayar di konter.', href: '/kasir', permission: 'fulfillment.pickup.handover' },
  { key: 'penjualan', label: 'Penjualan Konter', description: 'Lihat transaksi kasir dan fakturnya.', href: '/kantor/penjualan', permission: 'pos.report.view' },
  { key: 'setoran-kas', label: 'Setoran Kas', description: 'Hitung dan terima uang dari kasir.', href: '/kantor/setoran-kas', permission: 'payments.cash_custody.verify' },
  { key: 'keuangan', label: 'Keuangan', description: 'Tinjau jurnal, laporan, dan periode akuntansi.', href: '/keuangan', permission: 'finance.journal.create' },
] as const;

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
    workTiles: input.grants.state === 'OK'
      ? workTileDefinitions
        .filter((tile) => input.grants.state === 'OK' && input.grants.data.grants.some((grant) => grant.permission === tile.permission))
        .map(({ key, label, description, href }) => ({ key, label, description, href }))
      : [],
    sources,
    incomplete: sources.some((source) => source.state === 'UNAVAILABLE'),
    generatedAt: input.generatedAt.toISOString(),
  };
}
