import { createDomain } from './domain-template.mjs';

const name = process.argv[2];
if (!name) {
  process.stderr.write('Usage: pnpm gen:domain <kebab-case-name>\n');
  process.exitCode = 1;
} else {
  try {
    const root = new URL('../', import.meta.url).pathname;
    const directory = await createDomain(root, name);
    process.stdout.write(`Created ${directory}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

