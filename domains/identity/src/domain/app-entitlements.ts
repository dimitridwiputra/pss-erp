import { resolveRolePermissions } from './role-permissions';

/**
 * RBAC-003: app entitlement and permission-aware navigation.
 *
 * Per the spec, navigation is computed SERVER-SIDE (R01) from the user's effective
 * scoped permissions, and a denied permission means the menu item is absent rather
 * than disabled (BR01). A hidden entry is a real access control decision here, so
 * the resolver takes the permissions the server has already established — it never
 * asks the client what it may show.
 */

export type AppKey =
  | 'sales'
  | 'gudang'
  | 'antar'
  | 'admin'
  | 'supervisor'
  | 'keuangan'
  | 'control_station'
  | 'konsol';

/** Permission -> the app it unlocks. `app.<produk>.access` per the spec. */
const appAccessPermission: Readonly<Record<AppKey, string>> = {
  sales: 'app.sales.access',
  gudang: 'app.gudang.access',
  antar: 'app.antar.access',
  admin: 'app.admin.access',
  supervisor: 'app.supervisor.access',
  keuangan: 'app.keuangan.access',
  control_station: 'app.control_station.access',
  konsol: 'app.konsol.access',
};

/**
 * Which concrete permission groups evidence access to each app. An app is reachable
 * when the user holds at least one permission in its group — the spec says "menu
 * muncul hanya bila user punya minimal satu permission di bawahnya".
 */
const appEvidencePermissions: Readonly<Record<AppKey, readonly string[]>> = {
  sales: ['sfa.visit.execute', 'sfa.prospect.create', 'sfa.photo.create', 'orders.order_request.submit', 'orders.order.create', 'commercial.price.view'],
  gudang: ['wms.task.execute', 'wms.task.reassign', 'wms.count.review', 'wms.location.manage', 'inventory.count.execute', 'inventory.adjustment.request'],
  antar: ['fleet.delivery.execute', 'fleet.shipment.dispatch', 'fleet.shipment.plan', 'fleet.vehicle.manage'],
  admin: ['identity.user.manage', 'identity.role.assign', 'identity.session.revoke', 'identity.mfa.reset', 'identity.device.revoke'],
  supervisor: ['sfa.visit_plan.manage', 'sfa.team.view', 'wms.task.reassign', 'fleet.shipment.view', 'orders.order.manage', 'orders.order.resolve_shortage'],
  keuangan: [
    'finance.journal.create', 'finance.journal.submit', 'finance.journal.approve', 'finance.close.manage',
    'finance.period.reopen.request', 'payments.payment.record', 'payments.payment.apply', 'payments.payment.verify',
    'ar.write_off.request', 'ar.write_off.approve', 'ap.payment.prepare', 'ap.payment.approve',
    'tax.rate.manage', 'finance.coa.manage', 'finance.bank.reconcile',
  ],
  control_station: ['reporting.control_station.view'],
  konsol: ['integration.connector.manage', 'integration.mapping.decide', 'integration.batch.retry', 'platform.exception.work', 'audit.entry.read', 'audit.export'],
};

export interface AppEntitlement {
  app: AppKey;
  /** The `app.<produk>.access` permission name, used by the client for logging and tests. */
  accessPermission: string;
  /** Indonesian label. Labels live here, not in the UI, so every surface agrees. */
  label: string;
  /** Menu entries the user may open in this app. Absent rather than disabled (BR01). */
  items: { key: string; label: string }[];
}

interface AppDefinition {
  label: string;
  items: readonly { key: string; label: string; evidence: readonly string[] }[];
}

const appDefinitions: Readonly<Record<AppKey, AppDefinition>> = {
  sales: {
    label: 'PSS Sales',
    items: [
      { key: 'visit', label: 'Kunjungan', evidence: ['sfa.visit.execute'] },
      { key: 'prospect', label: 'Prospek', evidence: ['sfa.prospect.create'] },
      { key: 'order-request', label: 'Pesanan', evidence: ['orders.order_request.submit'] },
    ],
  },
  gudang: {
    label: 'PSS Gudang',
    items: [
      { key: 'task', label: 'Tugas', evidence: ['wms.task.execute'] },
      { key: 'count', label: 'Hitung', evidence: ['inventory.count.execute'] },
      { key: 'reassign', label: 'Pindah Tugas', evidence: ['wms.task.reassign'] },
    ],
  },
  antar: {
    label: 'PSS Antar',
    items: [
      { key: 'delivery', label: 'Pengiriman', evidence: ['fleet.delivery.execute'] },
      { key: 'dispatch', label: 'Dispatch', evidence: ['fleet.shipment.dispatch'] },
      { key: 'vehicle', label: 'Kendaraan', evidence: ['fleet.vehicle.manage'] },
    ],
  },
  admin: {
    label: 'Administrasi',
    items: [
      { key: 'user', label: 'Pengguna', evidence: ['identity.user.manage'] },
      { key: 'role', label: 'Peran & Akses', evidence: ['identity.role.assign'] },
      { key: 'session', label: 'Sesi', evidence: ['identity.session.revoke'] },
    ],
  },
  supervisor: {
    label: 'Supervisor',
    items: [
      { key: 'team', label: 'Tim', evidence: ['sfa.team.view'] },
      { key: 'plan', label: 'Rencana Kunjungan', evidence: ['sfa.visit_plan.manage'] },
      { key: 'order-manage', label: 'Kelola Pesanan', evidence: ['orders.order.manage'] },
    ],
  },
  keuangan: {
    label: 'PSS Keuangan',
    items: [
      { key: 'journal', label: 'Jurnal', evidence: ['finance.journal.create', 'finance.journal.approve'] },
      { key: 'period', label: 'Periode', evidence: ['finance.close.manage', 'finance.period.reopen.request'] },
      { key: 'receivable', label: 'Piutang', evidence: ['ar.write_off.request', 'ar.write_off.approve'] },
      { key: 'payment', label: 'Pembayaran', evidence: ['payments.payment.record', 'payments.payment.apply'] },
    ],
  },
  control_station: {
    label: 'Control Station',
    items: [{ key: 'dashboard', label: 'Dokumen', evidence: ['reporting.control_station.view'] }],
  },
  konsol: {
    label: 'Konsol Sistem',
    items: [
      { key: 'connector', label: 'Konektor', evidence: ['integration.connector.manage'] },
      { key: 'exception', label: 'Antrean Masalah', evidence: ['platform.exception.work'] },
      { key: 'audit', label: 'Audit', evidence: ['audit.entry.read', 'audit.export'] },
    ],
  },
};

/** BR02: the mobile bottom navigation may carry at most this many items. */
export const MAX_BOTTOM_NAV_ITEMS = 4;

export interface NavigationResult {
  apps: AppEntitlement[];
  bottomNav: { key: string; label: string; href: string }[];
  /** True when the bottom nav was trimmed, so the client can offer a "Lainnya" entry. */
  bottomNavTrimmed: boolean;
}

/**
 * Build the navigation for a set of already-resolved effective permissions.
 * A permission the user lacks removes the item entirely (BR01); it is never
 * returned as a disabled item the client could reveal.
 */
export function resolveNavigation(permissions: readonly string[]): NavigationResult {
  const held = new Set(permissions);

  const apps: AppEntitlement[] = [];
  for (const [app, definition] of Object.entries(appDefinitions) as [AppKey, AppDefinition][]) {
    const evidence = appEvidencePermissions[app];
    if (!evidence.some((permission) => held.has(permission))) continue;

    const items = definition.items
      .filter((item) => item.evidence.some((permission) => held.has(permission)))
      .map(({ key, label }) => ({ key, label }));

    // BR01: an app the user can enter but for which no menu item is reachable is
    // still shown, because the access permission itself is granted. An app with
    // neither is omitted above.
    apps.push({ app, accessPermission: appAccessPermission[app], label: definition.label, items });
  }

  // Deterministic order: follow the canonical app sequence, not the user's
  // permission set, so two users with identical access get identical navigation.
  const order: AppKey[] = ['sales', 'gudang', 'antar', 'admin', 'supervisor', 'keuangan', 'control_station', 'konsol'];
  apps.sort((left, right) => order.indexOf(left.app) - order.indexOf(right.app));

  const all = apps.map((entry) => ({ key: entry.app, label: entry.label, href: `/${entry.app}` }));
  const bottomNav = all.slice(0, MAX_BOTTOM_NAV_ITEMS);

  return { apps, bottomNav, bottomNavTrimmed: all.length > MAX_BOTTOM_NAV_ITEMS };
}

/** Effective permissions for a set of role codes, using the Appendix D registry. */
export function permissionsForRoles(roleCodes: readonly string[]): string[] {
  return [...new Set(roleCodes.flatMap((roleCode) => resolveRolePermissions(roleCode).permissions))].sort();
}
