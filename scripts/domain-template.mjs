import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const folders = [
  'domain/entities', 'domain/value-objects', 'domain/rules',
  'application/commands', 'application/queries', 'application/use-cases',
  'infrastructure/database/migrations', 'infrastructure/events', 'infrastructure/external',
  'interfaces/http', 'interfaces/events', 'tests',
];

export async function createDomain(root, name) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Domain name must be kebab-case, for example master-data.');
  }
  const destination = join(root, 'domains', name);
  try {
    await access(destination);
    throw new Error(`Domain already exists: ${name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(destination, { recursive: true });
  for (const folder of folders) {
    await mkdir(join(destination, folder), { recursive: true });
    await writeFile(join(destination, folder, '.gitkeep'), '');
  }
  await writeFile(join(destination, 'README.md'), `# ${name}\n\nRead [DOMAIN.md](DOMAIN.md) before adding behavior. This domain is scaffolded only.\n`);
  await writeFile(join(destination, 'DOMAIN.md'), `# ${name} domain\n\nStatus: scaffold only. Confirm ownership against the Product PRD before implementing behavior.\n\n## Purpose\n\nTo be defined by the first feature owned by this domain.\n\n## Owns\n\nNo implemented facts yet.\n\n## Does not own\n\nNo ownership claim is made by this scaffold.\n\n## Commands\n\nNone implemented.\n\n## Queries\n\nNone implemented.\n\n## Events produced and consumed\n\nNone implemented.\n\n## Tables\n\nNone.\n\n## Invariants\n\nNo implemented rules.\n\n## Dependencies\n\nNone implemented.\n\n## Open decisions\n\nSee the PRD Appendix J when defining this domain.\n\n## Acceptance tests\n\nNo behavior to test yet.\n`);
  return destination;
}

