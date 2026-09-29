import { describe, expect, it } from 'vitest';
import {
  checkForbiddenRoleCombinations, checkSystemAdministratorSod, evaluateAssignmentSod,
} from '../src/domain/segregation-of-duties';

const branch = (roleCode: string, branchId: string) => ({ roleCode, branchId });
const org = (roleCode: string) => ({ roleCode, branchId: null });

describe('SOD-07 system administrator holds no business mutation role', () => {
  it('rejects SYSTEM_ADMIN together with a business role', () => {
    const violations = checkSystemAdministratorSod([org('SYSTEM_ADMIN'), org('CASHIER')]);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('SOD-07');
  });

  it('allows SYSTEM_ADMIN with technical roles only', () => {
    expect(checkSystemAdministratorSod([org('SYSTEM_ADMIN'), org('GIS_ADMIN')])).toEqual([]);
    expect(checkSystemAdministratorSod([org('SYSTEM_ADMIN'), org('AUDIT_READ_ALL')])).toEqual([]);
  });
});

describe('SOD-08 forbidden role combinations', () => {
  it('rejects CASHIER with AR_OFFICER in the same branch', () => {
    const violations = checkForbiddenRoleCombinations([branch('CASHIER', 'b1'), branch('AR_OFFICER', 'b1')]);
    expect(violations.map((v) => v.rule)).toEqual(['SOD-08']);
    expect(violations[0].message).toContain('cabang yang sama');
  });

  it('allows CASHIER in one branch and AR_OFFICER in another', () => {
    expect(checkForbiddenRoleCombinations([branch('CASHIER', 'b1'), branch('AR_OFFICER', 'b2')])).toEqual([]);
  });

  it('treats an organization-wide holding as conflicting with any branch', () => {
    expect(checkForbiddenRoleCombinations([org('CASHIER'), branch('AR_OFFICER', 'b9')])).toHaveLength(1);
  });

  it('rejects POS_CASHIER with CASHIER in the same branch', () => {
    expect(checkForbiddenRoleCombinations([branch('POS_CASHIER', 'b1'), branch('CASHIER', 'b1')])).toHaveLength(1);
  });

  it('rejects FINANCE_MAKER with FINANCE_APPROVER regardless of branch', () => {
    expect(checkForbiddenRoleCombinations([branch('FINANCE_MAKER', 'b1'), branch('FINANCE_APPROVER', 'b2')])).toHaveLength(1);
  });

  it('rejects PROCUREMENT_OFFICER with FINANCE_APPROVER', () => {
    expect(checkForbiddenRoleCombinations([org('PROCUREMENT_OFFICER'), org('FINANCE_APPROVER')])).toHaveLength(1);
  });

  it('fails closed: an unverified exception does not suppress the rule', () => {
    const held = [branch('FINANCE_MAKER', 'b1'), branch('FINANCE_APPROVER', 'b1')];
    expect(checkForbiddenRoleCombinations(held)).toHaveLength(1);
    // A caller may only pass this after verifying a CFO-approved policy record.
    expect(checkForbiddenRoleCombinations(held, { hasSodException: true })).toEqual([]);
  });
});

describe('evaluateAssignmentSod on a proposed assignment', () => {
  it('allows a non-conflicting addition', () => {
    expect(evaluateAssignmentSod([branch('CASHIER', 'b1')], branch('WMS_EXEC', 'b1'))).toEqual([]);
  });

  it('rejects adding AR_OFFICER to a cashier in the same branch', () => {
    const violations = evaluateAssignmentSod([branch('CASHIER', 'b1')], branch('AR_OFFICER', 'b1'));
    expect(violations.map((v) => v.rule)).toContain('SOD-08');
  });

  it('allows the same pair in different branches', () => {
    expect(evaluateAssignmentSod([branch('CASHIER', 'b1')], branch('AR_OFFICER', 'b2'))).toEqual([]);
  });

  it('replaces rather than duplicates the same role at the same branch', () => {
    const existing = [branch('CASHIER', 'b1'), branch('AR_OFFICER', 'b1')];
    // Re-assigning CASHIER to itself must not manufacture a second conflict entry.
    expect(evaluateAssignmentSod(existing, branch('CASHIER', 'b1'))).toHaveLength(1);
  });

  it('rejects granting a business role to a system administrator', () => {
    const violations = evaluateAssignmentSod([org('SYSTEM_ADMIN')], org('FINANCE_APPROVER'));
    expect(violations.map((v) => v.rule)).toEqual(expect.arrayContaining(['SOD-07']));
  });
});
