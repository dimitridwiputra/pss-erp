import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!existsSync(new URL('../.git', import.meta.url))) {
  process.stdout.write('No Git checkout; skipped local hook installation.\n');
  process.exit(0);
}
try {
  const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (repositoryRoot !== root.replace(/\/$/, '')) throw new Error('Run hook installation from the repository root.');
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
  process.stdout.write('PLT-002 local pre-commit checks enabled.\n');
} catch (error) {
  if (error?.status === 128) process.stdout.write('No Git checkout; skipped local hook installation.\n');
  else throw error;
}
