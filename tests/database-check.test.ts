import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';

/**
 * The database gate is the last thing standing between a migration and production, and it runs
 * against SQL nobody re-reads after writing. A rule that cannot fire is worse than no rule, because
 * it is read as coverage, so each rule here is exercised against a violating migration as well as a
 * compliant one.
 */
const MIGRATION_DIRECTORIES = [
  'domains/audit/infrastructure/database/migrations',
  'domains/platform/infrastructure/database/migrations',
  'domains/identity/infrastructure/database/migrations',
];

async function allMigrations(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for (const directory of MIGRATION_DIRECTORIES) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.sql')) continue;
      files.push({ path: `${directory}/${entry}`, text: await readFile(`${directory}/${entry}`, 'utf8') });
    }
  }
  return files;
}

/** Mirrors the DDL scan in scripts/check-database.mjs, kept here so the rule is testable. */
function unqualifiedTables(text: string): string[] {
  const ddl = text
    .split('\n')
    .map((line) => (/^\s*--/.test(line) ? '' : line))
    .join('\n')
    .replace(/format\s*\(\s*'[^']*'/gi, "format('");
  const pattern = /(?:^|['"\s(])(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?)([a-z_][\w]*)(?:\.([a-z_][\w]*))?/gim;
  const unqualified: string[] = [];
  for (const match of ddl.matchAll(pattern)) {
    if (!match[2]) unqualified.push(match[1]);
  }
  return unqualified;
}

/** Same destructive-statement scan as scripts/check-database.mjs, comments excluded. */
function destructiveStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => (/^\s*--/.test(line) ? '' : line))
    .join('\n')
    .match(/\bDROP\s+(?:COLUMN|TABLE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?(?!ON\b)[a-z_][\w]*/gi) ?? [];
}

describe('PLT-002 migration gate', () => {
  it('accepts every migration currently in the repository', async () => {
    const migrations = await allMigrations();
    expect(migrations.length).toBeGreaterThan(15);
    for (const { path, text } of migrations) {
      expect(unqualifiedTables(text), `${path} declares a table without an owner schema`).toEqual([]);
    }
  });

  it('catches a table declared without an owner schema', () => {
    expect(unqualifiedTables('CREATE TABLE audit_entry (id uuid);')).toEqual(['audit_entry']);
  });

  it('does not fire on a schema-qualified create', () => {
    expect(unqualifiedTables('CREATE TABLE audit.audit_entry (id uuid);')).toEqual([]);
  });

  it('does not fire on a partitioned create whose name is a format placeholder', () => {
    // The real shape in 0005: the identifier is built at run time, so there is no literal table
    // name to qualify. Reading `audit` as a table name made the rule unsatisfiable here.
    const text = `
      EXECUTE format('CREATE TABLE audit.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        v_name, p_parent, v_month, v_upper);
    `;
    expect(unqualifiedTables(text)).toEqual([]);
  });

  it('does not fire on a mention inside a comment', () => {
    expect(unqualifiedTables('-- CREATE TABLE audit_entry (id uuid); is what this avoids.')).toEqual([]);
  });

  it('ships a plan beside every migration that drops something', async () => {
    const migrations = await allMigrations();
    const destructive = migrations.filter(({ text }) => destructiveStatements(text).length > 0);
    // If this is empty the rule is untested, not unnecessary.
    expect(destructive.length).toBeGreaterThan(0);
    for (const { path } of destructive) {
      // Same sibling convention as the gate: `name.migration-plan.md`, replacing the `.sql`.
      const planPath = path.replace(/\.sql$/, '.migration-plan.md');
      const plan = await readFile(planPath, 'utf8').catch(() => '');
      for (const heading of ['## Backfill', '## Compatibility', '## Rollback']) {
        expect(plan, `${path} drops something and needs a ${heading} section in ${planPath}`).toContain(heading);
      }
    }
  });
});
