import { execFileSync } from 'node:child_process';

const contractPaths = new Set(['docs/api/openapi.json', 'docs/events/schemas.json']);

export function readContractDocumentFromGit(ref, path, cwd) {
  if (!ref || !contractPaths.has(path)) throw new Error('A Git ref and known contract document path are required.');
  try {
    const content = execFileSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot read ${path} from Git ref ${ref}; contract compatibility cannot be verified.`, { cause: error });
  }
}
