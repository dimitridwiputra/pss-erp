import { createServiceLogger } from '@pss/observability';
import { Pool } from 'pg';

const logger = createServiceLogger('api');

/**
 * The API's PostgreSQL pool. `pg` emits `error` on the pool when an idle connection is cut (a
 * database restart, an administrator terminating sessions). With no listener that event is an
 * unhandled error and the whole API process exits, so a Postgres blip took every route down. With
 * one, `pg` discards that client and the next query opens a fresh connection. Only the error code
 * is logged; the connection string never is.
 */
export function createApiPool(): Pool | undefined {
  if (!process.env.DATABASE_URL) return undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (error: Error & { code?: string }) => {
    logger.warn({ code: error.code ?? 'UNKNOWN' }, 'Idle database connection closed; it will be replaced on next use');
  });
  return pool;
}
