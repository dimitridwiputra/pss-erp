import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { schemaOwners } from './check-database.mjs';

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

function sqlTableReferences(source) {
  const tree = ts.createSourceFile('file.ts', source, ts.ScriptTarget.Latest, true);
  const references = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'query' && node.arguments.length > 0) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) || ts.isTemplateExpression(argument)) {
        const sql = argument.getText(tree);
        for (const match of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][\w]*)\.([a-z_][\w]*)/gi)) {
          references.push({ schema: match[1].toLowerCase(), table: match[2] });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return references;
}

function directRoleDecisionReferences(source) {
  const tree = ts.createSourceFile('file.ts', source, ts.ScriptTarget.Latest, true);
  const matches = [];
  const isRoleExpression = (node) =>
    (ts.isIdentifier(node) && /^(?:role|roleCode)$/.test(node.text)) ||
    (ts.isPropertyAccessExpression(node) && /^(?:role|roleCode)$/.test(node.name.text));
  const isRoleCode = (node) => ts.isStringLiteral(node) && /^[A-Z][A-Z0-9_]+$/.test(node.text);
  function visit(node) {
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(node.operatorToken.kind) &&
      ((isRoleExpression(node.left) && isRoleCode(node.right)) ||
       (isRoleExpression(node.right) && isRoleCode(node.left)))) {
      matches.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return matches;
}

function parts(path) {
  return path.split(/[\\/]/).filter(Boolean);
}

export async function workspacePackagePaths(workspaceRoot) {
  const paths = new Map();
  for (const group of ['apps', 'packages', 'domains']) {
    const groupPath = join(workspaceRoot, group);
    for (const entry of await readdir(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(groupPath, entry.name);
      const contents = await readFile(join(directory, 'package.json'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!contents) continue;
      const manifest = JSON.parse(contents);
      if (manifest.name) paths.set(manifest.name, directory);
    }
  }
  return paths;
}

function resolveImport(path, specifier, workspacePackages) {
  if (specifier.startsWith('.')) return parts(resolve(dirname(path), specifier));
  for (const [name, directory] of workspacePackages) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return parts(resolve(directory, specifier.slice(name.length).replace(/^\//, '')));
    }
  }
  return [];
}

export function findArchitectureViolations(files, workspacePackages = new Map()) {
  const violations = [];
  for (const { path, source } of files) {
    const from = parts(path);
    const sourceDomainAt = from.lastIndexOf('domains');
    const sourceDomain = sourceDomainAt >= 0 ? from[sourceDomainAt + 1] : undefined;
    if (!from.includes('tests')) {
      for (const expression of directRoleDecisionReferences(source)) {
        violations.push(`${path} checks ${expression}: authorize by permission and scope, not role name (RBAC-001.R02).`);
      }
    }
    if (sourceDomain && !from.includes('tests')) {
      for (const { schema, table } of sqlTableReferences(source)) {
        if (schemaOwners[schema] && !schemaOwners[schema].includes(sourceDomain)) {
          violations.push(`${path} queries ${schema}.${table}: domain ${sourceDomain} cannot access another domain's tables (AGT §3.1).`);
        }
      }
    }
    for (const specifier of importsFrom(source)) {
      const target = resolveImport(path, specifier, workspacePackages);
      const domainAt = target.lastIndexOf('domains');
      const targetDomain = domainAt >= 0 ? target[domainAt + 1] : undefined;
      const sourcePackageAt = from.lastIndexOf('packages');
      const sourceAppAt = from.lastIndexOf('apps');
      const sourceApp = sourceAppAt >= 0 ? from[sourceAppAt + 1] : undefined;
      const targetLayer = domainAt >= 0 ? target[domainAt + 2] : undefined;
      const label = `${path} imports ${specifier}`;

      if (sourcePackageAt >= 0 && targetDomain) violations.push(`${label}: packages cannot import domains (PLT-002).`);
      // Audit is a platform foundation consumed by platform workflows; it is not a business domain.
      if (sourceDomain === 'platform' && targetDomain && targetDomain !== 'platform' && targetDomain !== 'audit') {
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
  const violations = findArchitectureViolations(files, await workspacePackagePaths(root));
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PLT-002 import boundaries: OK (${files.length} source files).\n`);
}
