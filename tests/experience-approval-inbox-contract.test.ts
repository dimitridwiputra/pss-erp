import { describe, expect, it } from 'vitest';
import { ProblemDetailsSchema } from '../packages/contracts/src/api/problem';
import {
  ApprovalDetailViewSchema,
  ApprovalInboxViewSchema,
  ExperienceApprovalCardSchema,
  ExperiencePermittedActionSchema,
  ExperienceStatusViewSchema,
  ExperienceSourceReportSchema,
  PendingApprovalProjectionSchema,
} from '../packages/contracts/src/api/experience-approval-inbox';

const status = {
  code: 'Q-APPROVAL_PENDING',
  label: 'Menunggu persetujuan Anda',
  tone: 'warning' as const,
  icon: 'stamp',
  known: true,
};

const card = {
  approvalId: '019a0000-0000-7000-8000-000000000001',
  status,
  subjectSummary: 'Override kredit · Toko Makmur · Rp 15 jt',
  amount: '15000000.00',
  amountLabel: 'Rp 15.000.000',
  expiresAt: '2026-09-30T06:00:00.000Z',
  deadlineLabel: 'Batas waktu 30 Sep 2026 13.00',
  permittedActions: [
    { action: 'APPROVE' as const, label: 'Setujui', requiresReason: true },
    { action: 'REJECT' as const, label: 'Tolak', requiresReason: true },
  ],
  href: '/persetujuan/019a0000-0000-7000-8000-000000000001',
};

const viewer = { displayName: 'Admin Demo PSS', organizationId: '019a0000-0000-7000-8000-00000000000a', canDecide: true };

const inboxView = {
  view: 'approval-inbox' as const,
  viewer,
  sources: [
    { source: 'identitySelf' as const, state: 'OK' as const },
    { source: 'identityGrants' as const, state: 'OK' as const },
    { source: 'platformApprovalInbox' as const, state: 'OK' as const },
  ],
  items: [card],
  incomplete: false,
  generatedAt: '2026-09-29T02:00:00.000Z',
};

describe('PLT-008 / APR-002 experience view-model contract', () => {
  it('APR-002.AC01 accepts a labelled card with its permitted actions', () => {
    expect(ApprovalInboxViewSchema.parse(inboxView).items).toHaveLength(1);
    expect(ExperienceApprovalCardSchema.parse(card).permittedActions.map((action) => action.label))
      .toEqual(['Setujui', 'Tolak']);
  });

  it('PLT-008.AC02 refuses any field that could carry a raw state string', () => {
    // A bare state has nowhere to live: the status field is an object with a label.
    expect(ExperienceStatusViewSchema.safeParse({ ...status, rawState: 'PENDING' }).success).toBe(false);
    expect(ExperienceStatusViewSchema.safeParse('PENDING').success).toBe(false);
    expect(ExperienceStatusViewSchema.safeParse({ code: 'PENDING', tone: 'warning' }).success).toBe(false);
    expect(ExperienceApprovalCardSchema.safeParse({ ...card, status: 'PENDING' }).success).toBe(false);
    expect(ExperienceApprovalCardSchema.safeParse({ ...card, state: 'PENDING' }).success).toBe(false);
  });

  it('PLT-008.AC02 rejects an unlabelled action and a raw decision value', () => {
    expect(ExperiencePermittedActionSchema.safeParse({ action: 'APPROVED', label: 'Setujui', requiresReason: true }).success).toBe(false);
    expect(ExperiencePermittedActionSchema.safeParse({ action: 'APPROVE', requiresReason: true }).success).toBe(false);
  });

  it('PLT-008.TS03 requires an explicit per-source outcome and marks an incomplete view', () => {
    const partial = {
      ...inboxView,
      sources: [
        { source: 'identitySelf' as const, state: 'OK' as const },
        { source: 'identityGrants' as const, state: 'UNAVAILABLE' as const, problemCode: 'DEPENDENCY_UNAVAILABLE' },
        { source: 'platformApprovalInbox' as const, state: 'UNAVAILABLE' as const, problemCode: 'DEPENDENCY_UNAVAILABLE' },
      ],
      items: null,
      incomplete: true,
    };
    expect(ApprovalInboxViewSchema.parse(partial).items).toBeNull();
    expect(ApprovalInboxViewSchema.parse(partial).incomplete).toBe(true);
    expect(ExperienceSourceReportSchema.safeParse({ source: 'identityGrants', state: 'UNAVAILABLE' }).success).toBe(false);
    expect(ApprovalInboxViewSchema.safeParse({ ...inboxView, sources: [] }).success).toBe(false);
  });

  it('keeps the detail view and the inbox view distinguishable', () => {
    expect(ApprovalDetailViewSchema.parse({
      view: 'approval-detail', viewer,
      sources: [{ source: 'identitySelf', state: 'OK' }, { source: 'identityGrants', state: 'OK' }],
      card, generatedAt: inboxView.generatedAt,
    }).card.approvalId).toBe(card.approvalId);
    expect(ApprovalInboxViewSchema.safeParse({
      view: 'approval-detail', viewer, sources: inboxView.sources, card, generatedAt: inboxView.generatedAt,
    }).success).toBe(false);
  });

  it('declares the upstream approval projection with its non-renderable fields', () => {
    const projection = PendingApprovalProjectionSchema.parse({
      id: card.approvalId,
      typeCode: 'credit_profile_change',
      summary: 'Perubahan batas kredit Toko Makmur',
      amount: '15000000.00',
      branchId: '019a0000-0000-7000-8000-00000000000b',
      expiresAt: card.expiresAt,
      requiredRole: 'BRANCH_MANAGER',
    });
    // The type code and the role code exist in the projection and nowhere in the view model.
    expect(projection.requiredRole).toBe('BRANCH_MANAGER');
    expect(ExperienceApprovalCardSchema.safeParse(projection).success).toBe(false);
  });

  it('PLT-007.AC01 problems from the BFF are the same RFC 9457 shape as the API', () => {
    const problem = ProblemDetailsSchema.parse({
      type: '/errors/PERMISSION_DENIED', title: 'Akses tidak tersedia', status: 403,
      detail: 'Hubungi admin jika Anda memerlukan akses.', instance: '/api/experience/approvals/{approvalId}',
      code: 'PERMISSION_DENIED', message: 'Hubungi admin jika Anda memerlukan akses.',
      requestId: 'req-1', correlationId: 'req-1', permittedActions: [], retryable: false,
    });
    expect(problem.status).toBe(403);
    expect(problem).not.toHaveProperty('stack');
    expect(problem).not.toHaveProperty('error');
  });
});
