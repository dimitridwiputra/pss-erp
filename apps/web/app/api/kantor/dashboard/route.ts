import { randomUUID } from 'node:crypto';
import { getPssServerAccessToken } from '../../../../auth';
import { resolveKantorDashboard } from '../../../../lib/kantor/dashboard';
import { jakartaToday } from '../../../kasir/lib/labels';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kantor/dashboard — the daily dashboard the /kantor home screen reads.
 *
 * The composition happens on the server, so the session token never reaches the browser and the
 * browser never learns which upstream answers which tile (MVP_PLAN §7). This handler adds only the
 * session token and the business date; every read, every schema, and every way a tile degrades is in
 * `lib/kantor/dashboard.ts`, which is unit-tested against fake transports.
 */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const dashboard = await resolveKantorDashboard({
    accessToken: await getPssServerAccessToken(),
    businessDate: jakartaToday(),
  });
  return Response.json(dashboard, { headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
}
