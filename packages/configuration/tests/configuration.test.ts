import { describe, expect, it } from 'vitest';
import { evaluateFlag, getConfig, PssFeatureFlagProvider } from '../src';

describe('configuration registry', () => {
  it('resolves effective dated, scoped values', () => {
    const rows = [
      { key: 'invoicing.recognition_point', scope: { organizationId: 'org-1' }, value: 'AT_DELIVERY', validFrom: '2026-01-01', status: 'ACTIVE' as const },
      { key: 'invoicing.recognition_point', scope: { organizationId: 'org-1', principalId: 'p-1', branchId: 'b-1' }, value: 'AT_DISPATCH', validFrom: '2026-11-01', status: 'ACTIVE' as const },
    ];
    expect(getConfig(rows, 'invoicing.recognition_point', { organizationId: 'org-1', principalId: 'p-1', branchId: 'b-1', businessDate: '2026-11-02' })).toMatchObject({ kind: 'VALUE', value: 'AT_DISPATCH' });
    expect(getConfig(rows, 'invoicing.recognition_point', { organizationId: 'org-1', principalId: 'p-1', branchId: 'b-1', businessDate: '2026-10-31' })).toMatchObject({ kind: 'VALUE', value: 'AT_DELIVERY' });
  });
  it('preserves empty values and fails closed for flags', async () => {
    expect(getConfig([{ key: 'tax.input_vat_tolerance', scope: { organizationId: 'org-1' }, value: null, validFrom: '2026-01-01', status: 'ACTIVE' }], 'tax.input_vat_tolerance', { organizationId: 'org-1', businessDate: '2026-02-01' })).toMatchObject({ kind: 'UNSET', reason: 'EMPTY_VALUE' });
    expect(evaluateFlag([{ key: 'sfa.app_enabled', enabled: true, target: { branchId: 'b-1' } }], 'sfa.app_enabled', { branchId: 'b-2' })).toBe(false);
    const provider = new PssFeatureFlagProvider([{ key: 'sfa.app_enabled', enabled: true, target: { branchId: 'b-1' } }]);
    await expect(provider.resolveBooleanEvaluation('sfa.app_enabled', false, { branchId: 'b-1' }, console)).resolves.toMatchObject({ value: true });
  });
});
