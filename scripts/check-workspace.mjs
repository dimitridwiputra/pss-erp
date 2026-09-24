import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const groups = ['apps', 'packages', 'domains'];

export function findDependencyProblems(manifests) {
  const versions = new Map();
  const problems = [];
  const disallowedValidators = new Set(['yup', 'joi', 'ajv', 'superstruct', 'valibot']);
  for (const [name, manifest] of manifests) {
    const entries = [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.devDependencies ?? {}),
    ];
    for (const [dependency, version] of entries) {
      if (disallowedValidators.has(dependency)) problems.push(`${name}: ${dependency} duplicates the approved Zod validator`);
      if (version.startsWith('workspace:')) continue;
      const prior = versions.get(dependency);
      if (prior && prior.version !== version) problems.push(`${dependency}: ${prior.name} uses ${prior.version}, ${name} uses ${version}`);
      else versions.set(dependency, { name, version });
    }
  }
  return problems;
}

export async function readWorkspaceManifests() {
  const manifests = [['root', JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))]];
  for (const group of groups) {
    const directory = new URL(`../${group}/`, import.meta.url);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory.pathname, entry.name, 'package.json');
      try {
        manifests.push([`${group}/${entry.name}`, JSON.parse(await readFile(path, 'utf8'))]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return manifests;
}

if (process.argv[1]?.endsWith('/check-workspace.mjs')) {
  const problems = findDependencyProblems(await readWorkspaceManifests());
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Workspace dependency versions and validator policy: OK\n');
  }
}
