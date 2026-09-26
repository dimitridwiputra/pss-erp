import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const schemaOwners = {
  identity: ['identity'],
  platform: ['platform'],
  audit: ['audit'],
  core: ['organization', 'master-data', 'principal-policy', 'commercial', 'tax'],
  sales: ['orders', 'credit', 'fulfillment', 'invoicing', 'returns'],
  inventory: ['inventory'],
  purchasing: ['procurement'],
  ar: ['ar'],
  payments: ['payments'],
  ap: ['ap'],
  finance: ['finance'],
  sfa: ['sfa'],
  wms: ['wms'],
  fleet: ['fleet'],
  geo: ['geo'],
  integration: ['integration'],
  reporting: ['reporting'],
};

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

export function checkMigration({ path, sql, plan = '' }) {
  const issues = [];
  const normalized = stripComments(sql);
  const domain = /(?:^|\/)domains\/([^/]+)\/infrastructure\/database\/migrations\//.exec(path)?.[1];
  if (!domain) return [`${path}: migration must live under its owning domain.`];

  const destructive = /\bDROP\s+(?:COLUMN|TABLE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?(?!ON\b)[a-z_][\w]*/i.test(normalized);
  if (destructive && !['Backfill', 'Compatibility', 'Rollback'].every((heading) => new RegExp(`^## ${heading}\\b`, 'im').test(plan))) {
    issues.push(`${path}: destructive migration requires a sibling .migration-plan.md with Backfill, Compatibility, and Rollback sections (PLT-002.AC02).`);
  }

  const tableStatements = [...normalized.matchAll(/\b(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?)([a-z_][\w]*)(?:\.([a-z_][\w]*))?/gi)];
  for (const match of tableStatements) {
    if (!match[2]) {
      issues.push(`${path}: table ${match[1]} must use an explicit owner schema.`);
      continue;
    }
    const schema = match[1].toLowerCase();
    if (!schemaOwners[schema]?.includes(domain)) {
      issues.push(`${path}: ${domain} cannot create or alter ${schema}.${match[2]} (DB.R01).`);
    }
  }

  const createdSchemas = [...normalized.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*)\./gi)].map((match) => match[1].toLowerCase());
  const referenceSchemas = [...normalized.matchAll(/\bREFERENCES\s+([a-z_][\w]*)\.([a-z_][\w]*)/gi)].map((match) => match[1].toLowerCase());
  for (const referenceSchema of referenceSchemas) {
    if (createdSchemas.some((schema) => schema !== referenceSchema)) {
      issues.push(`${path}: cross-schema foreign key to ${referenceSchema} is forbidden (DB.R02).`);
    }
  }
  return issues;
}

async function scanMigrations() {
  const issues = [];
  let checked = 0;
  for (const domain of await readdir(join(root, 'domains'))) {
    const directory = join(root, 'domains', domain, 'infrastructure/database/migrations');
    const entries = await readdir(directory).catch(() => []);
    for (const file of entries.filter((name) => name.endsWith('.sql'))) {
      const path = join(directory, file);
      const sql = await readFile(path, 'utf8');
      const plan = await readFile(path.replace(/\.sql$/, '.migration-plan.md'), 'utf8').catch(() => '');
      issues.push(...checkMigration({ path: relative(root, path), sql, plan }));
      checked += 1;
    }
  }
  return { issues, checked };
}

if (process.argv[1]?.endsWith('/check-database.mjs')) {
  const { issues, checked } = await scanMigrations();
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PLT-002 migration rules: OK (${checked} SQL migrations checked).\n`);
}
