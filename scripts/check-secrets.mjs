import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url).pathname;
const forbiddenPaths = /(^|\/)\.env(?:\.|$)/;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /(?:password|api[_-]?key|client[_-]?secret)\s*[:=]\s*["'][^"']{20,}["']/i,
];

export async function scanFiles(paths, readText) {
  const problems = [];
  for (const path of paths) {
    if (forbiddenPaths.test(path) && !path.endsWith('.env.example')) {
      problems.push(`${path}: environment file must not be committed`);
      continue;
    }
    if (/\.(png|jpg|jpeg|webp|ico|woff2?|pdf|lock)$/i.test(path) || path === 'pnpm-lock.yaml') continue;
    const content = await readText(path);
    if (secretPatterns.some((pattern) => pattern.test(content))) problems.push(`${path}: potential secret detected`);
  }
  return problems;
}

if (process.argv[1]?.endsWith('/check-secrets.mjs')) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  const paths = output.toString('utf8').split('\0').filter(Boolean);
  const problems = await scanFiles(paths, async (path) => await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Basic repository secret pattern check: OK\n');
}

