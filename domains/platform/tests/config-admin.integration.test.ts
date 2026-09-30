import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateFlag, getConfig, PssFeatureFlagProvider } from '../../../packages/configuration/src/index';
import { loadConfigRows, proposeConfigValue, configGateReport } from '../src/application/config-admin';
import { loadFlagRows, setFeatureFlag, setFlagTargeting, staleFeatureFlags } from '../src/application/flag-admin';

const databaseName = `pss_config_admin_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const branchId = randomUUID();
const principalId = randomUUID();
const adminId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const relativePath of [
    '../../audit/infrastructure/database/migrations/0001_audit_entry.sql',
    '../infrastructure/database/migrations/0001_outbox_event.sql',
    '../infrastructure/database/migrations/0003_approval.sql',
    '../infrastructure/database/migrations/0004_configuration.sql',
    '../infrastructure/database/migrations/0009_config_flag_admin.sql',
    // Seeds the per-key classification and the config_change approval type. Required before any
    // write, since an unclassified key raises CONFIG_KEY_UNKNOWN rather than defaulting, and it
    // depends on 0003_approval.sql for platform.approval_type.
    '../infrastructure/database/migrations/0010_config_key_registry.sql',
  ]) {
    await pool.query(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  }
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

/**
 * Every fixture key in this file is SENSITIVE in platform.config_key, so a proposal for one is held
 * at PENDING_APPROVAL rather than SCHEDULED — and an unapproved value is deliberately invisible to
 * `loadConfigRows`, since the whole point of that status is that it does not take effect.
 *
 * These tests are about effective-dating, scope resolution and the audit trail, so each proposal is
 * followed by the approval that promotes it. Without that step every read would legitimately return
 * UNSET and the tests would be asserting the wrong thing. The SENSITIVE routing itself is asserted
 * in apps/api/tests/config-admin.integration.test.ts, at the HTTP boundary.
 */
function proposal(overrides: Record<string, unknown> = {}) {
  return {
    organizationId, key: 'invoicing.recognition_point', scope: {}, value: 'AT_DELIVERY',
    validFrom: '2026-01-01', reason: 'Nilai awal recognition point', requiresOwnerApproval: false,
    approvalId: randomUUID(), requestId: randomUUID(), ...overrides,
  };
}

/** Promote a PENDING_APPROVAL row to SCHEDULED, as decideApproval would after a decision. */
async function approve(valueId: string): Promise<void> {
  const promoted = await pool.query(
    `UPDATE platform.config_value SET status = 'SCHEDULED', approved_by = $2
     WHERE id = $1 AND status = 'PENDING_APPROVAL'`,
    [valueId, adminId],
  );
  if (promoted.rowCount !== 1) throw new Error(`Value ${valueId} was not awaiting approval.`);
}

describe('PLT-009 effective-dated configuration registry', () => {
  it('resolves by business date and most specific scope, and supersedes rather than deletes', async () => {
    const organizationValue = await proposeConfigValue(pool, proposal(), adminId);
    await approve(organizationValue.id);
    // A first branch-scoped value, then a second one that supersedes it. The organization value
    // is a different scope, so it is not superseded by the branch value and vice versa.
    const firstBranchValue = await proposeConfigValue(pool, proposal({
      scope: { branchId }, value: 'AT_DELIVERY', validFrom: '2026-01-01',
      reason: 'Nilai awal cabang',
    }), adminId);
    await approve(firstBranchValue.id);
    const branchScoped = await proposeConfigValue(pool, proposal({
      scope: { branchId }, value: 'AT_DISPATCH', validFrom: '2026-11-01',
      reason: 'Principal X recognise at dispatch',
    }), adminId);
    await approve(branchScoped.id);

    const readRows = async (scope: Record<string, string>, businessDate: string) =>
      getConfig(await loadConfigRows(pool, { key: 'invoicing.recognition_point', organizationId, scope }),
        'invoicing.recognition_point', { organizationId, ...scope, businessDate });

    // PLT-009.AC01: the branch value wins from its own effective date, not before.
    expect(await readRows({ branchId }, '2026-10-31')).toMatchObject({ kind: 'VALUE', value: 'AT_DELIVERY' });
    expect(await readRows({ branchId }, '2026-11-02')).toMatchObject({ kind: 'VALUE', value: 'AT_DISPATCH' });
    // A different branch keeps the organization value.
    expect(await readRows({ branchId: randomUUID() }, '2026-11-02')).toMatchObject({ kind: 'VALUE', value: 'AT_DELIVERY' });

    // PLT-009.BR03 / NC01: the previous value is SUPERSEDED with a closed valid_to, not deleted,
    // and the superseding value is the next revision of the same scope.
    const history = await pool.query<{ id: string; status: string; valid_to: string; revision: number }>(
      `SELECT id, status, valid_to::text, revision FROM platform.config_value
       WHERE key = 'invoicing.recognition_point' AND branch_id = $1 ORDER BY valid_from`,
      [branchId],
    );
    expect(history.rows).toEqual([
      { id: firstBranchValue.id, status: 'SUPERSEDED', valid_to: '2026-11-01', revision: 1 },
      { id: branchScoped.id, status: 'SCHEDULED', valid_to: null, revision: 2 },
    ]);
  });

  it('fails closed on an empty value and never substitutes a default that grants something', async () => {
    // PLT-009.AC02 / BR04 / NC02: a KOSONG value reads as UNSET, and the caller sees no value at
    // all rather than a zero, a false, or the key's registered default text.
    const emptyValue = await proposeConfigValue(pool, proposal({ key: 'tax.rounding_rule', value: null }), adminId);
    await approve(emptyValue.id);
    const rows = await loadConfigRows(pool, { key: 'tax.rounding_rule', organizationId, scope: {} });
    expect(getConfig(rows, 'tax.rounding_rule', { organizationId, businessDate: '2026-03-01' }))
      .toMatchObject({ kind: 'UNSET', reason: 'EMPTY_VALUE' });

    // A key with no row at all is UNSET for the same reason, not the registry's default text.
    const absent = await loadConfigRows(pool, { key: 'credit.hold_expiry_hours', organizationId, scope: {} });
    expect(getConfig(absent, 'credit.hold_expiry_hours', { organizationId, businessDate: '2026-03-01' }))
      .toMatchObject({ kind: 'UNSET', reason: 'NO_ACTIVE_VALUE' });

    // A PENDING_APPROVAL value is not readable at all, so an unapproved change cannot grant
    // anything by accident (PLT-009.AC03 maker is not approver).
    await proposeConfigValue(pool, proposal({
      key: 'invoicing.grouping_rule', value: 'per DO', requiresOwnerApproval: true,
      approvalId: randomUUID(), reason: 'Menunggu persetujuan owner',
    }), adminId);
    const pending = await pool.query<{ status: string }>(
      `SELECT status FROM platform.config_value WHERE key = 'invoicing.grouping_rule'`,
    );
    expect(pending.rows).toEqual([{ status: 'PENDING_APPROVAL' }]);
    const pendingRows = await loadConfigRows(pool, { key: 'invoicing.grouping_rule', organizationId, scope: {} });
    expect(getConfig(pendingRows, 'invoicing.grouping_rule', { organizationId, businessDate: '2026-03-01' }))
      .toMatchObject({ kind: 'UNSET', reason: 'NO_ACTIVE_VALUE' });
  });

  it('refuses an unregistered key, a missing approval, a cross-organization read, and an inverted validity', async () => {
    await expect(proposeConfigValue(pool, proposal({ key: 'not.a.registered.key' }), adminId))
      .rejects.toThrow('CONFIG_KEY_UNKNOWN');
    // The helper supplies an approvalId, so the missing-approval case has to remove it explicitly.
    // Deleting the key is what a client omitting the field actually sends.
    const withoutApproval: Record<string, unknown> = proposal({
      key: 'invoicing.grouping_rule', requiresOwnerApproval: true,
    });
    delete withoutApproval.approvalId;
    await expect(proposeConfigValue(pool, withoutApproval, adminId)).rejects.toThrow('VALIDATION_FAILED');
    await expect(proposeConfigValue(pool, proposal({
      key: 'invoicing.grouping_rule', validFrom: '2026-05-01', validTo: '2026-05-01',
    }), adminId)).rejects.toThrow('VALIDATION_FAILED');

    // A value written by one organization is invisible to another (AGENTS.md §3.1 scope).
    const costing = await proposeConfigValue(pool, proposal({ key: 'inventory.costing_method', value: 'FIFO' }), adminId);
    await approve(costing.id);
    const foreign = await loadConfigRows(pool, {
      key: 'inventory.costing_method', organizationId: otherOrganizationId, scope: {},
    });
    expect(getConfig(foreign, 'inventory.costing_method', { organizationId: otherOrganizationId, businessDate: '2026-03-01' }))
      .toMatchObject({ kind: 'UNSET', reason: 'NO_ACTIVE_VALUE' });
  });

  it('writes a before/after audit entry for a configuration change', async () => {
    const first = await proposeConfigValue(pool, proposal({
      key: 'finance.post_discount_separately', value: true, reason: 'Diskon dicatat terpisah',
    }), adminId);
    await approve(first.id);
    const audit = await pool.query<{
      action: string; actor_user_id: string; reason_code: string; changes: Array<{ path: string; after: string }>;
    }>(
      `SELECT action, actor_user_id, reason_code, changes FROM audit.audit_entry
       WHERE entity_type = 'ConfigValue' AND action = 'CONFIG_VALUE_PROPOSED' AND entity_id = $1`,
      [first.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: adminId, reason_code: 'Diskon dicatat terpisah' });
    // The stored value is recorded as SET, never echoed: configuration values are CONFIDENTIAL.
    expect(audit.rows[0]?.changes.find((change) => change.path === 'value')?.after).toBe('SET');

    // A superseding proposal records both sides, so the history explains itself (PLT-009.R04).
    const superseding = await proposeConfigValue(pool, proposal({
      key: 'finance.post_discount_separately', value: false, validFrom: '2027-01-01',
      reason: 'Diskon digabung ke satu baris',
    }), adminId);
    await approve(superseding.id);
    const superseded = await pool.query<{ changes: Array<{ path: string; before?: string; after?: string }> }>(
      `SELECT changes FROM audit.audit_entry
       WHERE action = 'CONFIG_VALUE_SUPERSEDED' AND entity_id = $1`,
      [first.id],
    );
    expect(superseded.rowCount).toBe(1);
    expect(superseded.rows[0]?.changes).toContainEqual(
      { path: 'validTo', classification: 'INTERNAL', after: '2027-01-01' });
  });

  it('reports ASM/KOSONG/UNSET per registered key for the phase gate', async () => {
    const report = await configGateReport(pool, '2026-06-01');
    const byKey = new Map(report.map((entry) => [entry.key, entry]));
    expect(report.length).toBeGreaterThan(100);
    expect(byKey.get('invoicing.recognition_point')).toMatchObject({ value: 'SET', status: 'SCHEDULED' });
    expect(byKey.get('tax.rounding_rule')).toMatchObject({ value: 'KOSONG', status: 'SCHEDULED' });
    // A key nobody has set is reported as UNSET rather than being given its registry default.
    expect(byKey.get('orders.auto_confirm')).toMatchObject({ value: 'UNSET', status: 'UNSET' });
  });
});

describe('PLT-010 feature flag administration', () => {
  it('targets a flag per branch and falls back to the fail-closed global default', async () => {
    // PLT-010.AC01: branch A sees the feature, branch B does not.
    await setFeatureFlag(pool, {
      organizationId, key: 'sfa.app_enabled', enabled: false, owner: 'Engineering', requestId: randomUUID(),
    }, adminId);
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'sfa.app_enabled', branchId, enabled: true, priority: 10, requestId: randomUUID(),
    }, adminId);

    const otherBranchId = randomUUID();
    const enabledIn = async (contextBranch: string) => evaluateFlag(
      await loadFlagRows(pool, { key: 'sfa.app_enabled', context: { organizationId, branchId: contextBranch, roleCodes: [] } }),
      'sfa.app_enabled', { organizationId, branchId: contextBranch },
    );
    expect(await enabledIn(branchId)).toBe(true);
    expect(await enabledIn(otherBranchId)).toBe(false);

    // The same rows through the OpenFeature provider give the same answer, so a caller can use
    // either entry point without the two disagreeing.
    const provider = new PssFeatureFlagProvider(await loadFlagRows(pool, { key: 'sfa.app_enabled', context: { organizationId, branchId, roleCodes: [] } }));
    await expect(provider.resolveBooleanEvaluation('sfa.app_enabled', false, { organizationId, branchId }, console))
      .resolves.toMatchObject({ value: true });
    await expect(provider.resolveBooleanEvaluation('sfa.app_enabled', false, { organizationId, branchId: otherBranchId }, console))
      .resolves.toMatchObject({ value: false });
  });

  it('rolls a percentage out deterministically and honours the fail-closed default', async () => {
    // PLT-010.AC01: the same subject always gets the same decision, on every call.
    await setFeatureFlag(pool, {
      organizationId, key: 'supervisor.app_enabled', enabled: false, owner: 'Engineering', requestId: randomUUID(),
    }, adminId);
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'supervisor.app_enabled', branchId, enabled: true, percentage: 50,
      priority: 10, requestId: randomUUID(),
    }, adminId);

    const decide = async (userId: string) => evaluateFlag(
      await loadFlagRows(pool, { key: 'supervisor.app_enabled', context: { organizationId, branchId, userId, roleCodes: [] } }),
      'supervisor.app_enabled', { organizationId, branchId, userId },
    );
    const subjects = Array.from({ length: 40 }, () => randomUUID());
    const firstPass = await Promise.all(subjects.map(decide));
    const secondPass = await Promise.all(subjects.map(decide));
    expect(secondPass).toEqual(firstPass);
    // A 50% share over 40 distinct subjects must actually split the population, otherwise the
    // bucket is not a rollout at all.
    expect(firstPass).toContain(true);
    expect(firstPass).toContain(false);
    expect(firstPass.filter(Boolean).length).toBeGreaterThan(8);
    expect(firstPass.filter(Boolean).length).toBeLessThan(32);

    // 0% and 100% are the boundaries a staged rollout relies on, and both are deterministic.
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'supervisor.app_enabled', branchId, enabled: true, percentage: 0,
      priority: 10, requestId: randomUUID(),
    }, adminId);
    expect(await Promise.all(subjects.map(decide))).toEqual(subjects.map(() => false));
  });

  it('treats an expired rule as off and reports flags past their target removal date', async () => {
    // PLT-010.AC02 / NC02: expiry resolves to the global default, never to a stale "on".
    await setFeatureFlag(pool, {
      organizationId, key: 'fleet.digital_signature', enabled: false, owner: 'Engineering',
      targetRemoveDate: '2026-01-31', requestId: randomUUID(),
    }, adminId);
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'fleet.digital_signature', branchId, enabled: true, priority: 10,
      expiresAt: '2026-01-01T00:00:00.000Z', requestId: randomUUID(),
    }, adminId);
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'fleet.digital_signature', branchId: randomUUID(), enabled: true,
      priority: 10, expiresAt: '2099-01-01T00:00:00.000Z', requestId: randomUUID(),
    }, adminId);

    expect(evaluateFlag(
      await loadFlagRows(pool, { key: 'fleet.digital_signature', context: { organizationId, branchId, roleCodes: [] } }),
      'fleet.digital_signature', { organizationId, branchId },
    )).toBe(false);

    // PLT-010.AC04: a flag past its target removal date shows up in the cleanup report.
    const stale = await staleFeatureFlags(pool, '2026-06-01');
    expect(stale).toContainEqual({ key: 'fleet.digital_signature', owner: 'Engineering', targetRemoveDate: '2026-01-31', daysOverdue: 121 });
  });

  it('refuses an unregistered flag key and writes an audit entry for a flag change', async () => {
    await expect(setFeatureFlag(pool, {
      organizationId, key: 'not.a.registered.flag', enabled: true, owner: 'Engineering', requestId: randomUUID(),
    }, adminId)).rejects.toThrow('CONFIG_KEY_UNKNOWN');
    await expect(loadFlagRows(pool, { key: 'not.a.registered.flag', context: { organizationId, roleCodes: [] } }))
      .rejects.toThrow('CONFIG_KEY_UNKNOWN');

    await setFeatureFlag(pool, {
      organizationId, key: 'commercial.promo_enabled', enabled: true, owner: 'Commercial',
      requestId: randomUUID(),
    }, adminId);
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'commercial.promo_enabled', branchId, enabled: true, percentage: 25,
      priority: 5, requestId: randomUUID(),
    }, adminId);

    const flagAudit = await pool.query<{ action: string; actor_user_id: string; changes: Array<{ path: string; after: string }> }>(
      `SELECT a.action, a.actor_user_id, a.changes FROM audit.audit_entry a
       JOIN platform.feature_flag f ON f.id = a.entity_id
       WHERE a.entity_type = 'FeatureFlag' AND a.action = 'FEATURE_FLAG_CHANGED' AND f.key = 'commercial.promo_enabled'`,
    );
    expect(flagAudit.rowCount).toBe(1);
    expect(flagAudit.rows[0]).toMatchObject({ actor_user_id: adminId });
    expect(flagAudit.rows[0]?.changes).toContainEqual({ path: 'enabled', classification: 'INTERNAL', after: 'true' });

    const targetingAudit = await pool.query<{ changes: Array<{ path: string; after: string }> }>(
      `SELECT a.changes FROM audit.audit_entry a
       JOIN platform.feature_flag_targeting t ON t.id = a.entity_id
       WHERE a.entity_type = 'FlagTargeting' AND a.action = 'FEATURE_FLAG_CHANGED'
         AND t.flag_key = 'commercial.promo_enabled'`,
    );
    expect(targetingAudit.rowCount).toBe(1);
    expect(targetingAudit.rows[0]?.changes).toContainEqual({ path: 'percentage', classification: 'INTERNAL', after: '25' });
  });

  it('keeps a user override above a branch rule and leaves a kill switch ungated by percentage', async () => {
    await setFeatureFlag(pool, {
      organizationId, key: 'orders.whatsapp_intake_enabled', enabled: true, owner: 'Sales', requestId: randomUUID(),
    }, adminId);
    const userId = randomUUID();
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'orders.whatsapp_intake_enabled', branchId, enabled: false, percentage: 50,
      priority: 10, requestId: randomUUID(),
    }, adminId);
    await setFlagTargeting(pool, {
      organizationId, flagKey: 'orders.whatsapp_intake_enabled', branchId, userId, enabled: true,
      priority: 20, requestId: randomUUID(),
    }, adminId);

    const rows = await loadFlagRows(pool, { key: 'orders.whatsapp_intake_enabled', context: { organizationId, branchId, userId, roleCodes: [] } });
    expect(evaluateFlag(rows, 'orders.whatsapp_intake_enabled', { organizationId, branchId, userId })).toBe(true);
    // Another user in the same branch falls to the branch rule, whatever its rollout share.
    const otherUser = randomUUID();
    expect(evaluateFlag(
      await loadFlagRows(pool, { key: 'orders.whatsapp_intake_enabled', context: { organizationId, branchId, userId: otherUser, roleCodes: [] } }),
      'orders.whatsapp_intake_enabled', { organizationId, branchId, userId: otherUser },
    )).toBe(false);
  });
});

describe('configuration registry tenancy', () => {
  it('keeps a principal-scoped value ahead of the branch value for that principal only', async () => {
    const principalValue = await proposeConfigValue(pool, proposal({
      key: 'invoicing.top_start_basis', scope: { principalId }, value: 'ORDER_DATE',
      validFrom: '2026-01-01', reason: 'Principal X memakai order date',
    }), adminId);
    await approve(principalValue.id);
    const rows = await loadConfigRows(pool, { key: 'invoicing.top_start_basis', organizationId, scope: { principalId } });
    expect(getConfig(rows, 'invoicing.top_start_basis', { organizationId, principalId, businessDate: '2026-06-01' }))
      .toMatchObject({ kind: 'VALUE', value: 'ORDER_DATE' });
    // The same key with no principal scope has no value at all, so it stays UNSET rather than
    // borrowing another scope's setting.
    const unscoped = await loadConfigRows(pool, { key: 'invoicing.top_start_basis', organizationId, scope: {} });
    expect(getConfig(unscoped, 'invoicing.top_start_basis', { organizationId, businessDate: '2026-06-01' }))
      .toMatchObject({ kind: 'UNSET', reason: 'NO_ACTIVE_VALUE' });
  });
});
