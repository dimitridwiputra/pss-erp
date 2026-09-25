import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = new URL('../', import.meta.url).pathname;
const sourceExtensions = /\.[cm]?[jt]sx?$/;
const ignoredDirectories = new Set(['node_modules', 'dist', '.next', '.turbo', 'storybook-static']);

export async function sourceFiles(directory, extensions = sourceExtensions) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) result.push(...await sourceFiles(join(directory, entry.name), extensions));
    } else if (extensions.test(entry.name)) result.push(join(directory, entry.name));
  }
  return result;
}

function importsFrom(source) {
  const tree = ts.createSourceFile('file.ts', source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

function parts(path) {
  return path.split(/[\\/]/).filter(Boolean);
}

export function findArchitectureViolations(files) {
  const violations = [];
  for (const { path, source } of files) {
    const from = parts(path);
    for (const specifier of importsFrom(source)) {
      const target = specifier.startsWith('.') ? parts(resolve(dirname(path), specifier)) : [];
      const domainAt = target.lastIndexOf('domains');
      const targetDomain = domainAt >= 0 ? target[domainAt + 1] : undefined;
      const sourceDomainAt = from.lastIndexOf('domains');
      const sourceDomain = sourceDomainAt >= 0 ? from[sourceDomainAt + 1] : undefined;
      const sourcePackageAt = from.lastIndexOf('packages');
      const sourceAppAt = from.lastIndexOf('apps');
      const sourceApp = sourceAppAt >= 0 ? from[sourceAppAt + 1] : undefined;
      const targetLayer = domainAt >= 0 ? target[domainAt + 2] : undefined;
      const label = `${path} imports ${specifier}`;

      if (sourcePackageAt >= 0 && targetDomain) violations.push(`${label}: packages cannot import domains (PLT-002).`);
      if (sourceDomain === 'platform' && targetDomain && targetDomain !== 'platform') {
        violations.push(`${label}: platform cannot import a business domain (PLT-002).`);
      } else if (sourceDomain && targetDomain && sourceDomain !== targetDomain && ['domain', 'infrastructure'].includes(targetLayer)) {
        violations.push(`${label}: cross-domain internals are private; use a public application interface or contract (ADR-0004).`);
      }
      if (sourceDomain && sourceDomain !== 'integration' && targetDomain === 'integration' && target.includes('connectors')) {
        violations.push(`${label}: business domains cannot import integration connectors (PLT-002).`);
      }
      if ((sourceApp === 'web' || from.includes('bff')) && (/^(@prisma\/client|prisma|pg|typeorm|mongoose)(\/|$)/.test(specifier) || target.includes('infrastructure') && target.includes('database'))) {
        violations.push(`${label}: experience/BFF code cannot access a database directly (PLT-002).`);
      }
    }
  }
  return violations;
}

if (process.argv[1]?.endsWith(`check-architecture.mjs`)) {
  const paths = (await Promise.all(['apps', 'packages', 'domains'].map((directory) => sourceFiles(join(root, directory))))).flat();
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
  const violations = findArchitectureViolations(files);
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PLT-002 import boundaries: OK (${files.length} source files).\n`);
}
