import pg from 'pg';
import { applyPendingMigrations, ensureMigrationLedger } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for inventory migration.');

// Pending files only, read from the migrations directory and recorded in the shared ledger. This
// script used to name `0001` and `0002` explicitly, so `0003` (costing columns) and `0004` (the
// adjustment reason reference table) shipped and never ran from here; a hardcoded list is a
// migration that silently stops running. Replaying every file is unsafe on a live database (see
// applyPendingMigrations). `pnpm db:migrate` runs every domain.
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const bootstrap = await ensureMigrationLedger(client);
  await client.query('BEGIN');
  const outcome = await applyPendingMigrations(client, 'inventory', { bootstrap, report: (line) => process.stderr.write(`warning: ${line}\n`) });
  await client.query('COMMIT');
  process.stdout.write(`Inventory migrations: ${outcome.applied.length} applied, ${outcome.assumed.length} already present.\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
