import { readFile } from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for inventory migration.');

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  for (const file of ['0001_inventory.sql', '0002_inventory_receive_adjust.sql']) {
    const sql = await readFile(new URL(`../infrastructure/database/migrations/${file}`, import.meta.url), 'utf8');
    await client.query(sql);
  }
  await client.query('COMMIT');
  process.stdout.write('Inventory migrations 0001 applied.\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
