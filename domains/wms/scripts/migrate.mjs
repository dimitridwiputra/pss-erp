import { readFile } from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for wms migration.');

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  for (const file of ['0001_wms.sql', '0002_wms_reconciliation_and_units.sql', '0003_wms_pack_stage_load.sql', '0004_wms_presence_capacity_exceptions.sql']) {
    const sql = await readFile(new URL(`../infrastructure/database/migrations/${file}`, import.meta.url), 'utf8');
    await client.query(sql);
  }
  await client.query('COMMIT');
  process.stdout.write('WMS migrations applied.\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
