import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const requiredApps = ['web', 'api', 'finance-api', 'integration-worker', 'geo-service'];
const requiredPackages = ['contracts', 'ui', 'configuration', 'observability', 'auth-client', 'testing', 'offline'];
const requiredDomains = [
  'identity', 'organization', 'master-data', 'principal-policy', 'commercial',
  'orders', 'credit', 'fulfillment', 'inventory', 'invoicing', 'ar', 'payments',
  'finance', 'sfa', 'wms', 'fleet', 'geo', 'integration', 'reporting',
  'procurement', 'ap', 'tax', 'returns', 'platform', 'audit',
];
const requiredDomainFolders = ['domain', 'application', 'infrastructure', 'interfaces', 'tests'];
const problems = [];

async function requirePath(path) {
  try { await access(join(root, path)); }
  catch { problems.push(`Missing ${path}`); }
}

for (const app of requiredApps) await requirePath(`apps/${app}/Dockerfile`);
for (const name of requiredPackages) await requirePath(`packages/${name}/README.md`);
for (const name of requiredDomains) await requirePath(`domains/${name}/DOMAIN.md`);
for (const entry of await readdir(join(root, 'domains'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await requirePath(`domains/${entry.name}/DOMAIN.md`);
  for (const folder of requiredDomainFolders) await requirePath(`domains/${entry.name}/${folder}`);
}
for (const doc of ['AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/DESIGN_SYSTEM.md', 'docs/PRODUCT_PRD.md', 'docs/IMPLEMENTATION_PLAN.md']) await requirePath(doc);
if (problems.length) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write('PLT-001 repository structure: OK\n');
