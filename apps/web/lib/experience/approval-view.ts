import {
  findQueueSeed,
  findStatusCopy,
  type ApprovalDetailView,
  type ApprovalInboxView,
  type ExperienceApprovalCard,
  type ExperiencePermittedAction,
  type ExperienceSourceReport,
  type ExperienceStatusView,
  type ExperienceViewer,
  type PendingApprovalProjection,
} from '@pss/contracts';
import { formatRupiah, resolveStatus } from '@pss/ui';
import Decimal from 'decimal.js';
import type { IdentityGrants, IdentitySelf, SourceOutcome } from './sources';

/**
 * PLT-008 view composition for the approval inbox. Everything here is presentation: no
 * write, no stored state, no business decision (PLT-008.NC01, BR03).
 *
 * Indonesian copy is never authored here. Labels come from the registries
 * (`@pss/ui` status vocabulary, `@pss/contracts` queue and status catalog), so a state
 * without approved copy fails the registry checks instead of reaching a screen
 * (UX-002.E1, PLT-002.AC06).
 */

const APPROVAL_QUEUE_CODE = 'Q-APPROVAL_PENDING';

/**
 * UX-002.E2 / GAP-23: `ApprovalRequest` is not a state of PRD Appendix M, so
 * `resolveStatus` returns its "Status tidak dikenal" fallback. The product-approved label
 * for exactly this work is the registered exception-queue label (Appendix P
 * `Q-APPROVAL_PENDING`); the tone and icon are the ones Appendix M uses for the only
 * registered "menunggu persetujuan" state (`Journal · SUBMITTED`). Painting the fallback
 * on the queue's primary badge would show the wrong label, not a missing one.
 */
const APPROVAL_STATUS_TONE = findStatusCopy('Journal · SUBMITTED')?.tone ?? 'warning';
const APPROVAL_STATUS_ICON = findStatusCopy('Journal · SUBMITTED')?.icon ?? 'stamp';

/**
 * APR-002 in-scope actions are the two decisions Appendix P registers for this queue
 * (`permittedActions: "Setujui · Tolak"`). Both collect a reason: `decideApproval` rejects
 * a rejection without one and rejects an approval when the type sets `reason_required`,
 * and that per-type flag is not part of the inbox projection, so always collecting a
 * reason can only over-satisfy the rule and never drop the audit reason AGENTS.md §14
 * requires (APR-002.BR02).
 */
const DECISION_ACTIONS: readonly ExperiencePermittedAction[] = [
  { action: 'APPROVE', label: 'Setujui', requiresReason: true },
  { action: 'REJECT', label: 'Tolak', requiresReason: true },
];

const deadlineFormatter = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta',
});

export function approvalDetailPath(approvalId: string): string {
  return `/persetujuan/${approvalId}`;
}

/**
 * Exact whole-rupiah display. `Intl` groups the bigint, so no amount ever passes through
 * a float (AGENTS.md STK.R03). The platform approval projection only carries
 * non-negative amounts, so there is no sign branch to get wrong.
 */
export function rupiahLabel(amount: string): string {
  const whole = new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
  return formatRupiah(BigInt(whole));
}

function approvalPendingStatus(): ExperienceStatusView {
  const resolved = resolveStatus({ stcCode: 'ApprovalRequest', state: 'PENDING' });
  if (resolved.known) {
    return { code: resolved.code, label: resolved.label, tone: resolved.tone, icon: resolved.icon, known: true };
  }
  const queue = findQueueSeed(APPROVAL_QUEUE_CODE);
  if (!queue) {
    throw new Error(`${APPROVAL_QUEUE_CODE} is missing from the registry; run pnpm contracts:check before shipping a screen.`);
  }
  return {
    code: APPROVAL_QUEUE_CODE,
    label: queue.label,
    // `external` is a badge tone for another system's data, never a queue status (DSY §3.4).
    tone: APPROVAL_STATUS_TONE === 'external' ? 'warning' : APPROVAL_STATUS_TONE,
    icon: APPROVAL_STATUS_ICON,
    known: true,
  };
}

export function buildApprovalCard(projection: PendingApprovalProjection): ExperienceApprovalCard {
  return {
    approvalId: projection.id,
    status: approvalPendingStatus(),
    // The owning domain composed this context when it raised the request (APR-002.R01).
    // It is the only projection the inbox offers, and it is already user-facing copy.
    subjectSummary: projection.summary,
    amount: projection.amount,
    amountLabel: projection.amount === null ? null : rupiahLabel(projection.amount),
    expiresAt: projection.expiresAt,
    deadlineLabel: `Batas waktu ${deadlineFormatter.format(new Date(projection.expiresAt))}`,
    // Membership in the owning domain's inbox is the authorization result: the platform
    // approval query returns a row only after it accepted this caller for that row's
    // permission and scope. The BFF never re-derives it from a role name (RBAC-001.R02).
    permittedActions: [...DECISION_ACTIONS],
    href: approvalDetailPath(projection.id),
  };
}

export function sourceReport(outcome: SourceOutcome<unknown>): ExperienceSourceReport {
  return outcome.state === 'OK'
    ? { source: outcome.source, state: 'OK' }
    : { source: outcome.source, state: 'UNAVAILABLE', problemCode: outcome.problemCode };
}

/**
 * RBAC-003 product entitlement hint. It is a hint, not a gate: the domain filters the
 * inbox and re-authorizes every decision. PRD Appendix D does not mark which permissions
 * are decision permissions yet, so this infers them from the same `.approve` suffix
 * `/beranda` already uses; that inference is an open decision, not a policy.
 */
function buildViewer(self: IdentitySelf, grants: SourceOutcome<IdentityGrants>): ExperienceViewer {
  return {
    displayName: self.displayName,
    organizationId: self.organizationId,
    canDecide: grants.state === 'OK' && grants.data.grants.some((grant) => grant.permission.endsWith('.approve')),
  };
}

export function buildApprovalInboxView(input: {
  self: IdentitySelf;
  grants: SourceOutcome<IdentityGrants>;
  inbox: SourceOutcome<PendingApprovalProjection[]>;
  generatedAt: Date;
}): ApprovalInboxView {
  const sources: ExperienceSourceReport[] = [
    sourceReport({ source: 'identitySelf', state: 'OK', data: input.self }),
    sourceReport(input.grants),
    sourceReport(input.inbox),
  ];
  return {
    view: 'approval-inbox',
    viewer: buildViewer(input.self, input.grants),
    sources,
    // A failed read is `null`, never `[]`: an empty list would render as "nothing to do".
    items: input.inbox.state === 'OK' ? input.inbox.data.map(buildApprovalCard) : null,
    incomplete: sources.some((source) => source.state === 'UNAVAILABLE'),
    generatedAt: input.generatedAt.toISOString(),
  };
}

export function buildApprovalDetailView(input: {
  self: IdentitySelf;
  grants: SourceOutcome<IdentityGrants>;
  card: ExperienceApprovalCard;
  generatedAt: Date;
}): ApprovalDetailView {
  return {
    view: 'approval-detail',
    viewer: buildViewer(input.self, input.grants),
    sources: [
      sourceReport({ source: 'identitySelf', state: 'OK', data: input.self }),
      sourceReport(input.grants),
    ],
    card: input.card,
    generatedAt: input.generatedAt.toISOString(),
  };
}
