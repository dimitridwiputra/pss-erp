import pg from 'pg';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for tax migration.');

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  const applied = await applyMigrations(client, 'tax');
  await client.query('COMMIT');
  process.stdout.write(`Tax migrations applied: ${applied.join(', ')}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}