import { randomUUID } from 'node:crypto';
import { getPssServerAccessToken } from '../../../../../auth';
import { experienceResponse, resolveApprovalDetail } from '../../../../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../../../../lib/experience/transport';

export const dynamic = 'force-dynamic';

const INSTANCE = '/api/experience/approvals/{approvalId}';

/** APR-002 deep link: one approval the caller may act on, or a problem it may not. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const correlationId = request.headers.get('x-correlation-id') ?? requestId;
  const { approvalId } = await params;
  const outcome = await resolveApprovalDetail(
    {
      transport: httpUpstreamTransport,
      accessToken: await getPssServerAccessToken(),
      requestId,
      correlationId,
      instance: INSTANCE,
    },
    approvalId,
  );
  return experienceResponse(outcome, requestId);
}
