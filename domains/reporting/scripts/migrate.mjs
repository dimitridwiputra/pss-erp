import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for reporting migration.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const file of ['0001_delivery_order_read_model.sql', '0002_approval_read_model.sql']) {
    const sql = await readFile(new URL(`../infrastructure/database/migrations/${file}`, import.meta.url), 'utf8');
    await client.query(sql);
  }
  process.stdout.write('Reporting migrations 0001-0002 applied.\n');
} finally {
  await client.end();
}
