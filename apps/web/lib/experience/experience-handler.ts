import { createProblemDetails, DomainError, type ApprovalDetailView, type ApprovalInboxView, type ExperienceApprovalView, type ProblemDetails } from '@pss/contracts';
import { z } from 'zod';
import { buildApprovalCard, buildApprovalDetailView, buildApprovalInboxView } from './approval-view';
import { readIdentityGrants, readIdentitySelf, readPlatformApprovalInbox, type IdentitySelf, type UpstreamTransport } from './sources';

/**
 * PLT-008 handler core for the approval experience endpoints. It is framework-agnostic on
 * purpose: the Next route handlers in `app/api/experience/**` and the Server Components
 * that render `/persetujuan` both call these functions, so the composed view model and
 * its error shape are defined once (PLT-007.R02, PLT-008.R01).
 *
 * The only thing a route handler adds is the session token and the request id.
 */

export type ExperienceOutcome<TView extends ExperienceApprovalView = ExperienceApprovalView> =
  | { readonly kind: 'VIEW'; readonly view: TView }
  | { readonly kind: 'PROBLEM'; readonly problem: ProblemDetails };

export interface ExperienceRequestContext {
  readonly transport: UpstreamTransport;
  readonly accessToken: string | null;
  readonly now?: Date;
  readonly requestId: string;
  readonly correlationId?: string;
  readonly instance: string;
}

function unauthorized<TView extends ExperienceApprovalView>(context: ExperienceRequestContext): ExperienceOutcome<TView> {
  return { kind: 'PROBLEM', problem: problemOf(new DomainError('UNAUTHENTICATED'), context) };
}

/** PLT-007: the BFF answers with the same RFC 9457 shape the API uses. */
function problemOf(error: unknown, context: ExperienceRequestContext): ProblemDetails {
  return createProblemDetails(error, {
    requestId: context.requestId,
    correlationId: context.correlationId ?? context.requestId,
    instance: context.instance,
  });
}

function toOutcome<TView extends ExperienceApprovalView>(
  error: unknown,
  context: ExperienceRequestContext,
): ExperienceOutcome<TView> {
  return { kind: 'PROBLEM', problem: problemOf(error, context) };
}

/** The caller must be identifiable, so `/me` is the one mandatory read. */
function requireSelf(
  outcome: Awaited<ReturnType<typeof readIdentitySelf>>,
): asserts outcome is { source: 'identitySelf'; state: 'OK'; data: IdentitySelf } {
  if (outcome.state !== 'OK') throw new DomainError('DEPENDENCY_UNAVAILABLE');
}

export async function resolveApprovalInbox(context: ExperienceRequestContext): Promise<ExperienceOutcome<ApprovalInboxView>> {
  if (!context.accessToken) return unauthorized(context);
  try {
    const [self, grants, inbox] = await Promise.all([
      readIdentitySelf(context.transport, context.accessToken),
      readIdentityGrants(context.transport, context.accessToken),
      readPlatformApprovalInbox(context.transport, context.accessToken),
    ]);
    requireSelf(self);
    const view: ApprovalInboxView = buildApprovalInboxView({
      self: self.data, grants, inbox, generatedAt: context.now ?? new Date(),
    });
    return { kind: 'VIEW', view };
  } catch (error) {
    return toOutcome(error, context);
  }
}

/**
 * APR-002 deep link. The inbox is the only public read for a single approval, so a
 * request that is not in it is answered with the same `PERMISSION_DENIED` whether it
 * belongs to another branch, another approver, or does not exist at all. Distinguishing
 * those would disclose that a request exists outside the caller's scope, which is exactly
 * what BR02 forbids.
 */
export async function resolveApprovalDetail(
  context: ExperienceRequestContext,
  approvalId: string,
): Promise<ExperienceOutcome<ApprovalDetailView>> {
  if (!context.accessToken) return unauthorized(context);
  if (!z.uuid().safeParse(approvalId).success) {
    return { kind: 'PROBLEM', problem: problemOf(new DomainError('PERMISSION_DENIED'), context) };
  }
  try {
    const [self, grants, inbox] = await Promise.all([
      readIdentitySelf(context.transport, context.accessToken),
      readIdentityGrants(context.transport, context.accessToken),
      readPlatformApprovalInbox(context.transport, context.accessToken),
    ]);
    requireSelf(self);
    if (inbox.state !== 'OK') throw new DomainError('DEPENDENCY_UNAVAILABLE');
    const projection = inbox.data.find((candidate) => candidate.id === approvalId);
    if (!projection) throw new DomainError('PERMISSION_DENIED');
    const view: ApprovalDetailView = buildApprovalDetailView({
      self: self.data, grants, card: buildApprovalCard(projection), generatedAt: context.now ?? new Date(),
    });
    return { kind: 'VIEW', view };
  } catch (error) {
    return toOutcome(error, context);
  }
}

/** The single place that turns an outcome into an HTTP response, route handler or not. */
export function experienceResponse(outcome: ExperienceOutcome, requestId: string): Response {
  if (outcome.kind === 'VIEW') {
    return Response.json(outcome.view, { status: 200, headers: { 'x-request-id': requestId } });
  }
  const { problem } = outcome;
  return Response.json(problem, {
    status: problem.status,
    headers: {
      'content-type': 'application/problem+json',
      'x-request-id': problem.requestId,
      'x-correlation-id': problem.correlationId,
    },
  });
}
