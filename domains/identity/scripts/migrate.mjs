import { readFile } from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for identity migration.');

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  const sql = await readFile(new URL('../infrastructure/database/migrations/0001_user_account.sql', import.meta.url), 'utf8');
  await client.query(sql);
  await client.query('COMMIT');
  process.stdout.write('Identity migration 0001 applied.\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
