import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './check-architecture.mjs';

const root = new URL('../', import.meta.url).pathname;
const bannedLabels = new Set(['submit', 'ok', 'process']);

export function checkUiSource({ path, source }) {
  const issues = [];
  if (/#[0-9a-fA-F]{3,8}\b/.test(source) && !/packages\/ui\/(?:src\/tokens\.ts|tokens\.css)$/.test(path)) {
    issues.push(`${path}: use @pss/ui color tokens instead of a raw hex value (UX-001.AC01).`);
  }
  if (!/\.[jt]sx$/.test(path)) return issues;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'button') {
      const label = node.children.filter(ts.isJsxText).map((child) => child.text).join(' ').trim().toLowerCase();
      if (bannedLabels.has(label)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        issues.push(`${path}:${line}: button label "${label}" is not actionable Indonesian copy (UX-001.AC02).`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return issues;
}

if (process.argv[1]?.endsWith('/check-ui.mjs')) {
  const paths = (await Promise.all(['apps', 'packages'].map((directory) => sourceFiles(join(root, directory), /\.(css|[jt]sx)$/)))).flat()
    .filter((path) => !/\/(?:tests|__tests__)\//.test(path));
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
  const issues = files.flatMap(checkUiSource);
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`UX-001 token and button-copy lint: OK (${files.length} files).\n`);
}
