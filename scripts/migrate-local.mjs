import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { applyPendingMigrations, ensureMigrationLedger, listMigrations } from './apply-migrations.mjs';

/**
 * Apply every domain's pending migrations to one database, for local development and the demo
 * laptop. Each domain's own `scripts/migrate.mjs` used to name its files, and most named only
 * `0001`, so a new migration shipped and never ran: platform's 0010 and invoicing/payments 0002
 * were all silently skipped by `pnpm dev:up`. Here the domains and their files are both read from
 * disk, and `public.pss_schema_migration` records what ran (see `applyPendingMigrations`).
 * The foundation schemas go first because later domains reference them; every other domain
 * follows in name order, so a new domain is picked up without editing this file.
 */
const foundation = ['audit', 'platform', 'identity', 'master-data', 'commercial', 'inventory', 'orders', 'fulfillment', 'invoicing', 'payments'];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to apply migrations.');

const domainsRoot = new URL('../domains/', import.meta.url);
const withMigrations = [];
for (const entry of await readdir(domainsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const files = await listMigrations(new URL(`${entry.name}/infrastructure/database/migrations/`, domainsRoot)).catch(() => []);
  if (files.length) withMigrations.push(entry.name);
}
const order = [...foundation.filter((domain) => withMigrations.includes(domain)), ...withMigrations.filter((domain) => !foundation.includes(domain)).sort()];

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const bootstrap = await ensureMigrationLedger(client);
  if (bootstrap) process.stdout.write('This database predates the migration ledger; recording what is already applied.\n');
  const report = (line) => process.stderr.write(`warning: ${line}\n`);
  for (const domain of order) {
    await client.query('BEGIN');
    try {
      const outcome = await applyPendingMigrations(client, domain, { bootstrap, report });
      await client.query('COMMIT');
      if (outcome.applied.length || outcome.assumed.length) {
        process.stdout.write(`${domain}: ${outcome.applied.length} applied${outcome.assumed.length ? `, ${outcome.assumed.length} already present` : ''}\n`);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`${domain} migrations failed: ${error.message}`, { cause: error });
    }
  }
} finally {
  await client.end();
}
