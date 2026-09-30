import { randomUUID } from 'node:crypto';
import { createProblemDetails, DomainError } from '@pss/contracts';
import { getPssServerAccessToken } from '../../../../auth';
import { resolveShellView } from '../../../../lib/experience/shell-view';
import { httpUpstreamTransport } from '../../../../lib/experience/transport';

export const dynamic = 'force-dynamic';

/** The app shell's navigation (ExperienceShellViewSchema). 401 when the session has ended. */
export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const outcome = await resolveShellView(httpUpstreamTransport, await getPssServerAccessToken());
  if (outcome.kind === 'SIGNED_OUT') {
    const problem = createProblemDetails(new DomainError('UNAUTHENTICATED'), { requestId, correlationId: requestId, instance: '/api/experience/shell' });
    return Response.json(problem, { status: problem.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
  }
  return Response.json(outcome.view, { headers: { 'cache-control': 'no-store' } });
}
