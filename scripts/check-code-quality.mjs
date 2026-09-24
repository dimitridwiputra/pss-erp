import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './check-architecture.mjs';

const root = new URL('../', import.meta.url).pathname;
const comparisonOperators = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function isBusinessIdentity(node) {
  return /(?:principal|branch)(?:id|code|name)?/i.test(node.getText().replace(/\s/g, ''));
}

export function checkSourceQuality({ path, source }) {
  const issues = [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function add(node, message) {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    issues.push(`${path}:${line}: ${message}`);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === 'console' && node.expression.name.text === 'log') {
      add(node, 'console.log is forbidden in product source; use the structured logger (OBS-001).');
    }
    if (ts.isBinaryExpression(node) && comparisonOperators.has(node.operatorToken.kind)) {
      const leftLiteral = ts.isStringLiteral(node.left) && node.left.text.length > 0;
      const rightLiteral = ts.isStringLiteral(node.right) && node.right.text.length > 0;
      if ((leftLiteral && isBusinessIdentity(node.right)) || (rightLiteral && isBusinessIdentity(node.left))) {
        add(node, 'hard-coded principal/branch identity is forbidden; use policy or scoped reference data (AGT §3.2).');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const [index, line] of source.split('\n').entries()) {
    if (/\bTODO\b/.test(line) && /\/\/|\/\*/.test(line) && !/(?:OD-\d+|[A-Z]{2,}-\d+|#\d+)/.test(line)) {
      issues.push(`${path}:${index + 1}: TODO needs an issue or open-decision reference (AGT §18).`);
    }
  }
  return issues;
}

if (process.argv[1]?.endsWith('/check-code-quality.mjs')) {
  const paths = (await Promise.all(['apps', 'packages', 'domains'].map((directory) => sourceFiles(join(root, directory))))).flat()
    .filter((path) => !/\/(?:tests|__tests__)\//.test(path) && !/\.generated\./.test(path));
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
  const issues = files.flatMap(checkSourceQuality);
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PLT-002 source lint: OK (${files.length} product source files).\n`);
}
