import { z } from 'zod';
import { MoneyAmountSchema, UtcTimestampSchema } from '../primitives';

/**
 * PLT-008 experience view model for the cross-product approval inbox (APR-002) and
 * APR-002 / PLT-008 / PLT-007 / UX-002.
 *
 * Boundary rules encoded here (AGENTS.md §3.1, §9, §18; PRD PLT-008.R02, NC01, NC02):
 * - A status is only ever shipped as a labelled object. `ExperienceStatusView` has no
 *   field that could carry a raw state, so a product cannot render `PENDING`
 *   (UX-002.R02, PLT-002.AC06).
 * - `permittedActions` is part of the same response, so a screen never has to guess what
 *   the caller may do (PLT-008.R02, PLT-007.AC04).
 * - `sources` names every upstream read and whether it answered, so a partial response is
 *   recognisable as partial instead of being read as complete (PLT-008.E1, TS03).
 * - `items` is `null`, not `[]`, when the inbox read failed: an empty list would render as
 *   "no work waiting" and hide the failure.
 *
 * This module is types and shape validation only. It holds no business rule and no
 * Indonesian status copy; the copy comes from the registries in `@pss/contracts` and
 * `@pss/ui` at composition time (PLT-003.BR03).
 */

/** Where a value came from. The BFF reads domains only through these public reads. */
export const ExperienceSourceNameSchema = z.enum(['identitySelf', 'identityGrants', 'identityNavigation', 'platformApprovalInbox']);
export type ExperienceSourceName = z.infer<typeof ExperienceSourceNameSchema>;

export const ExperienceSourceStateSchema = z.enum(['OK', 'UNAVAILABLE']);
export type ExperienceSourceState = z.infer<typeof ExperienceSourceStateSchema>;

const ExperienceSourceIdentitySchema = z.strictObject({ source: ExperienceSourceNameSchema });

/**
 * A source that did not answer must say why: `UNAVAILABLE` without a `problemCode` is
 * rejected, so a partial response can never be shipped without a traceable cause
 * (PLT-008.TS03, AGENTS.md §3.7).
 */
export const ExperienceSourceReportSchema = z.discriminatedUnion('state', [
  ExperienceSourceIdentitySchema.extend({ state: z.literal('OK') }),
  ExperienceSourceIdentitySchema.extend({ state: z.literal('UNAVAILABLE'), problemCode: z.string().min(1) }),
]);
export type ExperienceSourceReport = z.infer<typeof ExperienceSourceReportSchema>;

/** UX-002.R02: `{code, label, tone, icon}` from the status vocabulary registry. */
export const ExperienceStatusViewSchema = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
  tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']),
  icon: z.string().min(1),
  /** False when the label came from the UX-002.E2 fallback and Product has no copy yet. */
  known: z.boolean(),
});
export type ExperienceStatusView = z.infer<typeof ExperienceStatusViewSchema>;

export const ExperienceDecisionActionSchema = z.enum(['APPROVE', 'REJECT']);
export type ExperienceDecisionAction = z.infer<typeof ExperienceDecisionActionSchema>;

export const ExperiencePermittedActionSchema = z.strictObject({
  action: ExperienceDecisionActionSchema,
  label: z.string().min(1),
  requiresReason: z.boolean(),
});
export type ExperiencePermittedAction = z.infer<typeof ExperiencePermittedActionSchema>;

export const ExperienceApprovalCardSchema = z.strictObject({
  approvalId: z.uuid(),
  status: ExperienceStatusViewSchema,
  /** Domain-composed, user-facing context (APR-002.R01). The only safe card title. */
  subjectSummary: z.string().min(1),
  amount: MoneyAmountSchema.nullable(),
  amountLabel: z.string().min(1).nullable(),
  expiresAt: UtcTimestampSchema,
  deadlineLabel: z.string().min(1),
  permittedActions: z.array(ExperiencePermittedActionSchema).min(1),
  href: z.string().min(1),
});
export type ExperienceApprovalCard = z.infer<typeof ExperienceApprovalCardSchema>;

/**
 * The projection `GET /platform/approvals/inbox` currently returns. It is declared here
 * so the BFF can validate an upstream payload at its boundary (PLT-003.R03) instead of
 * casting it. `typeCode` and `requiredRole` stay inside the BFF: neither is a user-facing
 * label and neither may be rendered (RBAC-001.R02, UX-002.NC01).
 */
export const PendingApprovalProjectionSchema = z.strictObject({
  id: z.uuid(),
  typeCode: z.string().min(1),
  summary: z.string().min(1),
  amount: MoneyAmountSchema.nullable(),
  branchId: z.uuid().nullable(),
  expiresAt: UtcTimestampSchema,
  requiredRole: z.string().min(1),
});
export type PendingApprovalProjection = z.infer<typeof PendingApprovalProjectionSchema>;

export const ExperienceViewerSchema = z.strictObject({
  displayName: z.string().min(1),
  organizationId: z.uuid(),
  /**
   * Affordance hint only. The authoritative scope filter is the owning domain's inbox
   * read, and every decision is re-authorized by the domain (RBAC-002, PLT-008.BR02).
   */
  canDecide: z.boolean(),
});
export type ExperienceViewer = z.infer<typeof ExperienceViewerSchema>;

export const ApprovalInboxViewSchema = z.strictObject({
  view: z.literal('approval-inbox'),
  viewer: ExperienceViewerSchema,
  sources: z.array(ExperienceSourceReportSchema).min(1),
  items: z.array(ExperienceApprovalCardSchema).nullable(),
  /** True when at least one source did not answer; the response is partial by definition. */
  incomplete: z.boolean(),
  generatedAt: UtcTimestampSchema,
});
export type ApprovalInboxView = z.infer<typeof ApprovalInboxViewSchema>;

export const ApprovalDetailViewSchema = z.strictObject({
  view: z.literal('approval-detail'),
  viewer: ExperienceViewerSchema,
  sources: z.array(ExperienceSourceReportSchema).min(1),
  card: ExperienceApprovalCardSchema,
  generatedAt: UtcTimestampSchema,
});
export type ApprovalDetailView = z.infer<typeof ApprovalDetailViewSchema>;

export type ExperienceApprovalView = ApprovalInboxView | ApprovalDetailView;
