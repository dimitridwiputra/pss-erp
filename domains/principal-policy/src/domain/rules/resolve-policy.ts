import { DomainError } from '@pss/contracts';
import { z } from 'zod';

/** Approved history is eligible even after a row is superseded or expires. */
export type PolicyRow = {
  policyRowId: string;
  organizationId: string;
  process: string;
  principalId: string | null;
  revenueStream: string | null;
  branchId: string | null;
  warehouseId: string | null;
  activeFrom: string;
  activeTo: string | null;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'SUPERSEDED' | 'EXPIRED';
  sourceOfTruth: string;
  pssMode: 'OBSERVED' | 'MANAGED';
  manualEntryMode: string | null;
  pssSfaMode: string | null;
  syncDirection: string | null;
  connectorInstanceId: string | null;
};

export type ResolvePolicyInput = {
  organizationId: string;
  process: string;
  principalId?: string;
  revenueStream?: string;
  branchId?: string;
  warehouseId?: string;
  businessDate: string;
};

export type PolicyDecision = Pick<PolicyRow,
  'policyRowId' | 'sourceOfTruth' | 'pssMode' | 'manualEntryMode' |
  'pssSfaMode' | 'syncDirection' | 'connectorInstanceId'>;

const isoDate = z.iso.date();
const publishedStatuses = new Set<PolicyRow['status']>(['ACTIVE', 'SUPERSEDED', 'EXPIRED']);

function specificity(row: PolicyRow, input: ResolvePolicyInput): number {
  if (input.process === 'INVENTORY' || input.process === 'FULFILLMENT') {
    // DEC-113: neither principal nor stream may affect warehouse authority.
    if (row.principalId !== null || row.revenueStream !== null) return 0;
    if (row.warehouseId !== null) {
      if (row.warehouseId !== input.warehouseId) return 0;
      if (row.branchId !== null && row.branchId !== input.branchId) return 0;
      return 3;
    }
    if (row.branchId !== null) return row.branchId === input.branchId ? 2 : 0;
    return 1;
  }

  if (row.warehouseId !== null) return 0;
  if (row.principalId !== null) {
    if (row.principalId !== input.principalId) return 0;
    if (row.branchId !== null && row.branchId !== input.branchId) return 0;
    if (row.revenueStream !== null && row.revenueStream !== input.revenueStream) return 0;
    if (row.branchId !== null && row.revenueStream !== null) return 6;
    if (row.branchId !== null) return 5;
    if (row.revenueStream !== null) return 4;
    return 3;
  }
  // The PRD defines DEFAULT + stream and DEFAULT, but not DEFAULT + branch.
  if (row.branchId !== null) return 0;
  if (row.revenueStream !== null) return row.revenueStream === input.revenueStream ? 2 : 0;
  return 1;
}

/** Pure decision rule; callers supply approved policy history and persist missing-policy exceptions. */
export function resolvePolicy(input: ResolvePolicyInput, rows: readonly PolicyRow[]): PolicyDecision {
  if (!isoDate.safeParse(input.businessDate).success) {
    throw new DomainError('VALIDATION_FAILED', [], [
      { path: 'businessDate', code: 'INVALID_DATE', message: 'Tanggal bisnis harus berformat YYYY-MM-DD.' },
    ]);
  }

  let best: PolicyRow | undefined;
  let bestSpecificity = 0;
  let ambiguous = false;
  for (const row of rows) {
    if (row.organizationId !== input.organizationId || row.process !== input.process) continue;
    if (!publishedStatuses.has(row.status)) continue;
    if (row.activeFrom > input.businessDate || (row.activeTo !== null && row.activeTo < input.businessDate)) continue;

    const rank = specificity(row, input);
    if (rank === 0) continue;
    if (rank > bestSpecificity) {
      best = row;
      bestSpecificity = rank;
      ambiguous = false;
    } else if (rank === bestSpecificity) {
      ambiguous = true;
    }
  }
  if (!best) throw new DomainError('POLICY_NOT_FOUND');
  // A lower-ranked collision cannot invalidate an unambiguous higher-ranked row.
  if (ambiguous) throw new DomainError('POLICY_OVERLAP');
  return {
    policyRowId: best.policyRowId,
    sourceOfTruth: best.sourceOfTruth,
    pssMode: best.pssMode,
    manualEntryMode: best.manualEntryMode,
    pssSfaMode: best.pssSfaMode,
    syncDirection: best.syncDirection,
    connectorInstanceId: best.connectorInstanceId,
  };
}
