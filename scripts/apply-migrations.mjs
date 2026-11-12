import { createHash } from 'node:crypto';
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

/**
 * Apply only a domain's migrations that this database has not recorded, for a real (non-test)
 * database. Replaying every file is safe on a fresh database and is what the fixtures above do,
 * but not on a live one: audit's 0003–0006 prepare and then perform a table swap, so replaying them
 * after the swap tries to swap again. Recording what ran is the standard answer.
 *
 * A database that predates the ledger is bootstrapped once, per file, in a savepoint. A file whose
 * effect is already present fails there and is recorded as ASSUMED_APPLIED (reported, never
 * silent). A replayable file simply re-runs, so a migration that a hardcoded per-domain list had
 * skipped is applied for real. Later runs apply only files the ledger has not seen; a recorded
 * file whose content changed is reported, because a shipped migration must not be amended
 * (MIG-RISK-AUD-001).
 *
 * The caller owns the transaction.
 */
export async function applyPendingMigrations(client, domain, { bootstrap = false, report = () => {} } = {}) {
  const directory = migrationsDirectory(domain);
  const recorded = new Map((await client.query(
    'SELECT file, checksum FROM public.pss_schema_migration WHERE domain = $1', [domain],
  )).rows.map((row) => [row.file, row.checksum]));
  const outcome = { applied: [], assumed: [], changed: [] };
  for (const file of await listMigrations(directory)) {
    const sql = await readFile(join(directory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (recorded.has(file)) {
      if (recorded.get(file) !== checksum) outcome.changed.push(file);
      continue;
    }
    let state = 'APPLIED';
    if (bootstrap) {
      await client.query('SAVEPOINT pss_migration');
      try {
        await client.query(sql);
        await client.query('RELEASE SAVEPOINT pss_migration');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT pss_migration');
        state = 'ASSUMED_APPLIED';
        report(`${domain}/${file}: not re-run on this pre-ledger database (${error.message}); recorded as already applied.`);
      }
    } else {
      await client.query(sql);
    }
    await client.query(
      'INSERT INTO public.pss_schema_migration (domain, file, checksum, outcome) VALUES ($1, $2, $3, $4)',
      [domain, file, checksum, state],
    );
    (state === 'APPLIED' ? outcome.applied : outcome.assumed).push(file);
  }
  for (const file of outcome.changed) report(`${domain}/${file}: content differs from the version recorded as applied. Shipped migrations must not be amended; add a new one.`);
  return outcome;
}

/** Create the ledger; true when this database predates it and already holds schemas (bootstrap). */
export async function ensureMigrationLedger(client) {
  const existed = (await client.query("SELECT to_regclass('public.pss_schema_migration') IS NOT NULL AS present")).rows[0].present;
  await client.query(`CREATE TABLE IF NOT EXISTS public.pss_schema_migration (
    domain text NOT NULL,
    file text NOT NULL,
    checksum text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('APPLIED', 'ASSUMED_APPLIED')),
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, file)
  )`);
  if (existed) return false;
  const populated = (await client.query(
    "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname IN ('audit', 'platform', 'identity', 'sales', 'pos', 'core', 'inventory', 'payments')",
  )).rows[0].count;
  return populated > 0;
}
