import { randomUUID } from 'node:crypto';
import { getPssServerAccessToken } from '../../../../auth';
import { experienceResponse, resolveApprovalInbox } from '../../../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../../../lib/experience/transport';

export const dynamic = 'force-dynamic';

const INSTANCE = '/api/experience/approvals';

/**
 * PLT-008 experience endpoint for the cross-product approval inbox (APR-002).
 * Session resolution and the composed view model live elsewhere; this handler only turns
 * them into a response.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const correlationId = request.headers.get('x-correlation-id') ?? requestId;
  const outcome = await resolveApprovalInbox({
    transport: httpUpstreamTransport,
    accessToken: await getPssServerAccessToken(),
    requestId,
    correlationId,
    instance: INSTANCE,
  });
  return experienceResponse(outcome, requestId);
}
