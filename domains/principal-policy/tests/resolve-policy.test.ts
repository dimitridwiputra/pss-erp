import { describe, expect, it } from 'vitest';
import { resolvePolicy, type PolicyRow, type ResolvePolicyInput } from '../src';

const input: ResolvePolicyInput = {
  organizationId: 'org-a', process: 'ORDER_CAPTURE', principalId: 'principal-a',
  revenueStream: 'stream-a', branchId: 'branch-a', businessDate: '2026-11-01',
};

function row(policyRowId: string, overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    policyRowId, organizationId: 'org-a', process: 'ORDER_CAPTURE',
    principalId: null, revenueStream: null, branchId: null, warehouseId: null,
    activeFrom: '2026-01-01', activeTo: null, status: 'ACTIVE',
    sourceOfTruth: 'LEGACY', pssMode: 'OBSERVED', manualEntryMode: null,
    pssSfaMode: null, syncDirection: null, connectorInstanceId: null,
    ...overrides,
  };
}

describe('PRI-004 policy resolution', () => {
  it('uses every PRD precedence tier, regardless of row order', () => {
    const tiers = [
      row('default'),
      row('default-stream', { revenueStream: 'stream-a' }),
      row('principal', { principalId: 'principal-a' }),
      row('principal-stream', { principalId: 'principal-a', revenueStream: 'stream-a' }),
      row('principal-branch', { principalId: 'principal-a', branchId: 'branch-a' }),
      row('principal-branch-stream', { principalId: 'principal-a', branchId: 'branch-a', revenueStream: 'stream-a' }),
    ];
    for (let count = 1; count <= tiers.length; count++) {
      const candidates = tiers.slice(0, count);
      expect(resolvePolicy(input, candidates).policyRowId).toBe(candidates.at(-1)?.policyRowId);
      expect(resolvePolicy(input, [...candidates].reverse()).policyRowId).toBe(candidates.at(-1)?.policyRowId);
    }
  });

  it('uses the transaction business date, including the inclusive cutover boundary', () => {
    const rows = [
      row('old', { principalId: 'principal-a', activeTo: '2026-10-31', status: 'SUPERSEDED' }),
      row('new', { principalId: 'principal-a', activeFrom: '2026-11-01', sourceOfTruth: 'PSS', pssMode: 'MANAGED' }),
    ];
    expect(resolvePolicy({ ...input, businessDate: '2026-10-31' }, rows).policyRowId).toBe('old');
    expect(resolvePolicy(input, rows).policyRowId).toBe('new');
  });

  it('resolves INVENTORY by warehouse, then branch, then default regardless of principal', () => {
    const rows = [
      row('default', { process: 'INVENTORY' }),
      row('branch', { process: 'INVENTORY', branchId: 'branch-a' }),
      row('warehouse', { process: 'INVENTORY', warehouseId: 'warehouse-a', sourceOfTruth: 'PSS', pssMode: 'MANAGED' }),
      row('invalid-principal-scope', { process: 'INVENTORY', warehouseId: 'warehouse-a', principalId: 'principal-a' }),
    ];
    for (const principalId of ['principal-a', 'principal-b']) {
      expect(resolvePolicy({ ...input, process: 'INVENTORY', principalId, warehouseId: 'warehouse-a' }, rows))
        .toMatchObject({ policyRowId: 'warehouse', pssMode: 'MANAGED' });
    }
    expect(resolvePolicy({ ...input, process: 'INVENTORY' }, rows).policyRowId).toBe('branch');
    expect(resolvePolicy({ ...input, process: 'INVENTORY', branchId: 'branch-b' }, rows).policyRowId).toBe('default');
  });

  it('fails closed when there is no published, dated, same-organization match', () => {
    const rows = [
      row('draft', { status: 'DRAFT' }),
      row('scheduled', { status: 'SCHEDULED' }),
      row('other-org', { organizationId: 'org-b' }),
      row('future', { activeFrom: '2026-11-02' }),
      row('other-process', { process: 'COLLECTION' }),
    ];
    expect(() => resolvePolicy(input, rows)).toThrowError('POLICY_NOT_FOUND');
    expect(() => resolvePolicy({ ...input, businessDate: '2026-02-30' }, [])).toThrowError('VALIDATION_FAILED');
  });

  it('rejects equal-ranked overlap but tolerates a lower-ranked collision', () => {
    const duplicateDefaults = [row('a'), row('b')];
    expect(() => resolvePolicy(input, duplicateDefaults)).toThrowError('POLICY_OVERLAP');
    expect(resolvePolicy(input, [...duplicateDefaults, row('specific', { principalId: 'principal-a' })]).policyRowId)
      .toBe('specific');
  });

  it('does not consider an undefined default plus branch tier', () => {
    expect(() => resolvePolicy(input, [row('default-branch', { branchId: 'branch-a' })]))
      .toThrowError('POLICY_NOT_FOUND');
  });
});
