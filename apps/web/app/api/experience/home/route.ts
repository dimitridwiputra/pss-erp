import { randomUUID } from 'node:crypto';
import { getPssServerAccessToken } from '../../../../auth';
import { experienceResponse, resolveHome } from '../../../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../../../lib/experience/transport';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const outcome = await resolveHome({
    transport: httpUpstreamTransport,
    accessToken: await getPssServerAccessToken(),
    requestId,
    correlationId: request.headers.get('x-correlation-id') ?? requestId,
    instance: '/api/experience/home',
  });
  return experienceResponse(outcome, requestId);
}
