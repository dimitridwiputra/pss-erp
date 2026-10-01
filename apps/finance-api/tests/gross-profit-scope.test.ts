import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveRolePermissions } from '../../../domains/identity/src/domain/role-permissions';
import { FinanceGrossProfitSummaryQuerySchema, type UserPermissionGrant } from '@pss/contracts';
import { grossProfitScopeForGrants } from '../src/finance-auth';

const organizationId = randomUUID();
const ownBranch = randomUUID();
const otherBranch = randomUUID();
const user = { id: randomUUID(), organizationId, displayName: 'Pengguna', primaryBranchId: ownBranch };
const grant = (scopeType: 'ORGANIZATION' | 'BRANCH', scopeId: string): UserPermissionGrant => ({
  permission: 'control_station.gross_profit_summary.view', scopeType, scopeId,
});

describe('MVP-OD-10 gross-profit summary authorization', () => {
  it('accepts only a dated, scoped query contract', () => {
    expect(FinanceGrossProfitSummaryQuerySchema.parse({ businessDate: '2026-10-15', branchId: ownBranch }))
      .toEqual({ businessDate: '2026-10-15', branchId: ownBranch });
    expect(FinanceGrossProfitSummaryQuerySchema.safeParse({ businessDate: '2026-10-15',
      branchId: 'all-branches' }).success).toBe(false);
  });
  it('allows a Branch Manager only their assigned branch, enforced before the query', () => {
    const permissions = resolveRolePermissions('BRANCH_MANAGER').permissions;
    expect(permissions).toContain('control_station.gross_profit_summary.view');
    expect(grossProfitScopeForGrants(user, [grant('BRANCH', ownBranch)])).toEqual({
      organizationId, branchId: ownBranch,
    });
    expect(() => grossProfitScopeForGrants(user, [grant('BRANCH', ownBranch)], otherBranch))
      .toThrow('PERMISSION_DENIED');
    expect(permissions).not.toContain('finance.journal.lines.view');
    expect(permissions).not.toContain('finance.journal.create');
  });

  it('allows CEO and COO at organization scope and gives no aggregate grant to Sales Supervisor', () => {
    for (const role of ['CEO','COO']) {
      expect(resolveRolePermissions(role).permissions).toContain('control_station.gross_profit_summary.view');
      expect(grossProfitScopeForGrants(user, [grant('ORGANIZATION', organizationId)])).toEqual({
        organizationId, branchId: null,
      });
    }
    expect(resolveRolePermissions('SALES_SUPERVISOR').permissions)
      .not.toContain('control_station.gross_profit_summary.view');
    expect(() => grossProfitScopeForGrants(user, [])).toThrow('PERMISSION_DENIED');
  });

  it('does not turn summary access into P&L or General Ledger access', () => {
    const summaryOnly = [grant('BRANCH', ownBranch)];
    expect(summaryOnly.some((item) => item.permission === 'finance.journal.lines.view')).toBe(false);
    expect(summaryOnly.some((item) => item.permission === 'finance.report.pnl.view')).toBe(false);
    expect(resolveRolePermissions('DATA_ANALYST').permissions)
      .not.toContain('control_station.gross_profit_summary.view');
  });
});
