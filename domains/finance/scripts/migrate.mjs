import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  const directory = new URL('../infrastructure/database/migrations/', import.meta.url);
  for (const filename of (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    await client.query(await readFile(new URL(filename, directory), 'utf8'));
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
