import { describe, expect, it } from 'vitest';
import { MAX_BOTTOM_NAV_ITEMS, permissionsForRoles, resolveNavigation } from '../src/domain/app-entitlements';

const appKeys = (navigation: ReturnType<typeof resolveNavigation>) => navigation.apps.map((entry) => entry.app);
const itemKeys = (navigation: ReturnType<typeof resolveNavigation>, app: string) =>
  navigation.apps.find((entry) => entry.app === app)?.items.map((item) => item.key) ?? [];

describe('RBAC-003 permission-aware navigation', () => {
  it('shows nothing for a user with no effective permissions', () => {
    const navigation = resolveNavigation([]);
    expect(navigation.apps).toEqual([]);
    expect(navigation.bottomNav).toEqual([]);
  });

  it('BR01 omits an app entirely when no permission below it is held', () => {
    expect(appKeys(resolveNavigation(['finance.journal.create']))).not.toContain('gudang');
    expect(appKeys(resolveNavigation(['wms.task.execute']))).toContain('gudang');
  });

  it('BR01 hides the individual item the user may not open', () => {
    const navigation = resolveNavigation(['wms.task.execute']);
    // The user may run tasks but may not reassign them.
    expect(itemKeys(navigation, 'gudang')).toEqual(['task']);
    expect(itemKeys(navigation, 'gudang')).not.toContain('reassign');
  });

  it('exposes a menu item when ANY of its evidencing permissions is held', () => {
    // A stock counter executes counts (inventory.count.execute); a count reviewer
    // resolves discrepancies (wms.count.review) and gets no counting menu item.
    expect(itemKeys(resolveNavigation(['inventory.count.execute']), 'gudang')).toContain('count');
    expect(itemKeys(resolveNavigation(['wms.count.review']), 'gudang')).not.toContain('count');
  });

  it('BR02 caps mobile bottom navigation at four items and flags the trim', () => {
    // Appendix D role codes, not permission-group codes.
    const navigation = resolveNavigation(permissionsForRoles([
      'SYSTEM_ADMIN', 'FINANCE_APPROVER', 'WAREHOUSE_OPERATOR', 'SALES_REP', 'DISPATCHER', 'BRANCH_MANAGER', 'INTERNAL_AUDIT',
    ]));
    expect(navigation.apps.length).toBeGreaterThan(MAX_BOTTOM_NAV_ITEMS);
    expect(navigation.bottomNav).toHaveLength(MAX_BOTTOM_NAV_ITEMS);
    expect(navigation.bottomNavTrimmed).toBe(true);
  });

  it('does not flag a trim when the user has few enough apps', () => {
    const navigation = resolveNavigation(['wms.task.execute']);
    expect(navigation.bottomNavTrimmed).toBe(false);
    expect(navigation.bottomNav).toHaveLength(1);
  });

  it('R01 produces identical navigation for identical access, independent of order', () => {
    const first = resolveNavigation(['wms.task.execute', 'finance.journal.create', 'sfa.visit.execute']);
    const second = resolveNavigation(['sfa.visit.execute', 'finance.journal.create', 'wms.task.execute']);
    expect(appKeys(first)).toEqual(appKeys(second));
    expect(appKeys(first)).toEqual(['sales', 'gudang', 'keuangan']);
  });

  it('keeps the system console to technical permissions only', () => {
    const navigation = resolveNavigation(['integration.connector.manage', 'identity.user.manage']);
    expect(appKeys(navigation)).toContain('konsol');
    expect(itemKeys(navigation, 'konsol').sort()).toEqual(['connector', 'user']);
    expect(appKeys(navigation)).not.toContain('admin');
  });

  it('routes Sales Admin work to PSS Admin rather than the field Sales app', () => {
    const navigation = resolveNavigation(permissionsForRoles(['SALES_ADMIN']));
    expect(appKeys(navigation)).toContain('admin');
    expect(appKeys(navigation)).not.toContain('sales');
    expect(navigation.apps.find((entry) => entry.app === 'admin')?.label).toBe('PSS Admin');
    expect(itemKeys(navigation, 'admin')).toContain('orders');
  });

  it('never emits a raw technical code in an app or item label', () => {
    const navigation = resolveNavigation(permissionsForRoles([
      'SYSTEM_ADMIN', 'CONTROLLER', 'WAREHOUSE_OPERATOR', 'SALES_REP', 'DISPATCHER', 'BRANCH_MANAGER',
    ]));
    const labels = [
      ...navigation.apps.map((entry) => entry.label),
      ...navigation.apps.flatMap((entry) => entry.items.map((item) => item.label)),
    ];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // A label must not contain a dotted permission, an underscore token, or digits.
      expect(label).not.toMatch(/[._]/);
      expect(label).not.toMatch(/\d/);
    }
  });

  it('exposes the app.<produk>.access permission name for every app', () => {
    const navigation = resolveNavigation(permissionsForRoles([
      'SYSTEM_ADMIN', 'CONTROLLER', 'WAREHOUSE_OPERATOR', 'SALES_REP', 'DISPATCHER', 'BRANCH_MANAGER',
    ]));
    expect(navigation.apps.length).toBeGreaterThan(0);
    for (const entry of navigation.apps) {
      expect(entry.accessPermission).toBe(`app.${entry.app}.access`);
    }
  });
});
