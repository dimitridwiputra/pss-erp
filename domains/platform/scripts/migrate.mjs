import { readFile } from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for platform migration.');

const migrationFiles = [
  '0001_outbox_event.sql',
  '0002_idempotency_key.sql',
  '0003_approval.sql',
  '0004_configuration.sql',
  '0005_event_delivery_reliability.sql',
  '0006_exception_queue.sql',
  '0007_exception_queue_registry_seed.sql',
];
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  for (const migrationFile of migrationFiles) {
    const sql = await readFile(new URL(`../infrastructure/database/migrations/${migrationFile}`, import.meta.url), 'utf8');
    await client.query(sql);
  }
  await client.query('COMMIT');
  process.stdout.write(`Platform migrations ${migrationFiles[0].slice(0, 4)}-${migrationFiles.at(-1).slice(0, 4)} applied.\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
