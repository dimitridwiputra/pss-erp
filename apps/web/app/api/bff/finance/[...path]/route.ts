import { bffRouteHandlers } from '../../../../../lib/bff/route-handlers';

export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, PATCH, DELETE } = bffRouteHandlers('finance');
