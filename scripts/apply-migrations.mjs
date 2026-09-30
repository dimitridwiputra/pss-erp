import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Replay a domain's migrations in filename order, for a test database.
 *
 * Fixtures used to hardcode a single migration file, usually `0001`. That is what made it tempting
 * to amend a shipped migration: a new column was needed, the fixture replayed only `0001`, and
 * adding the column to `0001` was the shortest path — at the cost of rewriting history, which is
 * MIG-RISK-AUD-001. Replaying the ordered list removes the temptation, because a domain's migrations
 * then compose the way they do in production and a fixture can no longer fall behind silently.
 *
 * Ordering is by filename because the numbering is the only ordering that exists. The list is read
 * from the directory rather than hardcoded, so a new migration is picked up without editing a
 * fixture: a hardcoded list is a migration that quietly stops running when someone adds 0007.
 *
 * Every statement in this repository's migrations is written to be replayable, so applying the list
 * to a fresh database is the supported path.
 */

const migrationsDirectory = (domain) => resolve(
  repositoryRoot, 'domains', domain, 'infrastructure', 'database', 'migrations',
);

export async function listMigrations(directory) {
  return (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
}

export async function applyMigrations(executor, domain) {
  const directory = migrationsDirectory(domain);
  const applied = [];
  for (const file of await listMigrations(directory)) {
    await executor.query(await readFile(join(directory, file), 'utf8'));
    applied.push(file);
  }
  return applied;
}

/**
 * Apply the audit domain's migrations.
 *
 * `audit` is the domain nearly every other fixture needs, because a mutation that must be audited
 * writes an audit row and the writer names `retention_class`. This exists so a fixture asks for
 * "the audit schema" rather than for one file, which is what let a shipped migration be amended.
 */
export async function applyAuditMigrations(executor) {
  return applyMigrations(executor, 'audit');
}

/** Apply a domain's migrations to an executor that takes one SQL string. */
export async function applyDomainMigrations(executor, domain) {
  const directory = migrationsDirectory(domain);
  for (const file of await listMigrations(directory)) {
    await executor(await readFile(join(directory, file), 'utf8'));
  }
}
