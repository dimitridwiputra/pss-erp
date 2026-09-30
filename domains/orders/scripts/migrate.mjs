import pg from 'pg';
import { applyPendingMigrations, ensureMigrationLedger } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for orders migration.');

// Pending files only, read from the migrations directory and recorded in the shared ledger. A
// hardcoded list silently stops applying the next migration someone adds; replaying every file is
// unsafe on a live database (see applyPendingMigrations). `pnpm db:migrate` runs every domain.
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const bootstrap = await ensureMigrationLedger(client);
  await client.query('BEGIN');
  const outcome = await applyPendingMigrations(client, 'orders', { bootstrap, report: (line) => process.stderr.write(`warning: ${line}\n`) });
  await client.query('COMMIT');
  process.stdout.write(`Orders migrations: ${outcome.applied.length} applied, ${outcome.assumed.length} already present.\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
