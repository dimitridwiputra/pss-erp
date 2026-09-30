import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkAccess, type RoleAssignment, type ScopeType } from '../src/application/access-policy';
import { checkForbiddenRoleCombinations, checkSystemAdministratorSod } from '../src/domain/segregation-of-duties';
import { resolveRolePermissions } from '../src/domain/role-permissions';

interface DemoSeed {
  organization: { id: string };
  branch: { id: string };
  warehouse: { id: string };
  users: { username: string; userId: string; roles: { roleCode: string; scopeType: ScopeType }[] }[];
}

const seed = JSON.parse(readFileSync(new URL('../../../infrastructure/keycloak/pss-demo-users.json', import.meta.url), 'utf8')) as DemoSeed;

function scopeIdFor(scopeType: ScopeType): string {
  if (scopeType === 'ORGANIZATION') return seed.organization.id;
  if (scopeType === 'BRANCH') return seed.branch.id;
  if (scopeType === 'WAREHOUSE') return seed.warehouse.id;
  throw new Error(`The demo seed does not use scope ${scopeType}.`);
}

function assignmentsOf(username: string): RoleAssignment[] {
  const user = seed.users.find((entry) => entry.username === username);
  if (!user) throw new Error(`${username} is not in the demo seed.`);
  return user.roles.map((role) => ({ roleCode: role.roleCode, scopeType: role.scopeType, scopeId: scopeIdFor(role.scopeType) }));
}

const demoResource = { organizationId: seed.organization.id, branchId: seed.branch.id, warehouseId: seed.warehouse.id };

function can(username: string, permission: string, resource = demoResource): boolean {
  const user = seed.users.find((entry) => entry.username === username);
  return checkAccess({
    actorId: user?.userId ?? '', organizationId: seed.organization.id,
    assignments: assignmentsOf(username), permission, resource,
  });
}

// MVP_PLAN §7: what each demo user does, as the concrete Appendix D permission it needs.
const mustGrant: Record<string, string[]> = {
  'kasir.demo': [
    'pos.shift.open', 'pos.sale.create', 'pos.sale.checkout', 'pos.tender.accept', 'pos.shift.close',
    'pos.receipt.reprint', 'payments.cash_handover.declare',
  ],
  'gudang.demo': ['fulfillment.pickup.handover', 'procurement.receipt.post'],
  'admin.demo': ['commercial.price_list.manage', 'inventory.adjustment.request'],
  'keuangan.demo': ['payments.cash_custody.verify', 'finance.journal.create', 'finance.journal.submit'],
  'kepala.keuangan.demo': ['finance.journal.approve', 'finance.close.manage'],
};

// The separations the demo story depends on (SOD-06, SOD-09, AGENTS.md §4.5).
const mustDeny: Record<string, string[]> = {
  'kasir.demo': ['payments.cash_custody.verify', 'fulfillment.pickup.handover', 'finance.journal.create'],
  'gudang.demo': ['pos.tender.accept', 'payments.cash_custody.verify'],
  'admin.demo': ['pos.tender.accept', 'payments.cash_custody.verify', 'finance.journal.approve'],
  'keuangan.demo': ['finance.journal.approve', 'pos.tender.accept', 'payments.cash_handover.declare'],
  'kepala.keuangan.demo': ['payments.cash_custody.verify', 'pos.tender.accept'],
};

describe('MVP demo roles (MVP_PLAN §7)', () => {
  it('seeds exactly the five demo users with registered roles', () => {
    expect(seed.users.map((user) => user.username).sort()).toEqual(Object.keys(mustGrant).sort());
    for (const user of seed.users) {
      for (const role of user.roles) expect(resolveRolePermissions(role.roleCode).permissions.length).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(mustGrant))('%s holds what the demo needs, in the demo scope', (username, permissions) => {
    for (const permission of permissions) expect({ permission, allowed: can(username, permission) }).toEqual({ permission, allowed: true });
  });

  it.each(Object.entries(mustDeny))('%s cannot act for another role', (username, permissions) => {
    for (const permission of permissions) expect({ permission, allowed: can(username, permission) }).toEqual({ permission, allowed: false });
  });

  it('grants nothing in another organization, branch or warehouse', () => {
    const elsewhere = '0199a000-0000-7000-8000-00000000e999';
    expect(can('kasir.demo', 'pos.sale.create', { ...demoResource, warehouseId: elsewhere })).toBe(false);
    expect(can('keuangan.demo', 'payments.cash_custody.verify', { ...demoResource, branchId: elsewhere })).toBe(false);
    expect(can('kepala.keuangan.demo', 'finance.journal.approve', { ...demoResource, organizationId: elsewhere })).toBe(false);
  });

  it('keeps every demo user free of SOD-07/08 violations', () => {
    for (const user of seed.users) {
      const views = user.roles.map((role) => ({
        roleCode: role.roleCode,
        branchId: role.scopeType === 'ORGANIZATION' ? null : seed.branch.id,
      }));
      expect({ user: user.username, violations: [...checkSystemAdministratorSod(views), ...checkForbiddenRoleCombinations(views)] })
        .toEqual({ user: user.username, violations: [] });
    }
  });

  it('transcribes POS-EXEC without the pos.credit_sale feature flag', () => {
    const permissions = resolveRolePermissions('POS_CASHIER').permissions;
    expect(permissions).toContain('pos.credit_sale.request');
    expect(permissions).not.toContain('pos.credit_sale');
  });
});
