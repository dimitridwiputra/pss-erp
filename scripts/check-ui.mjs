import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './check-architecture.mjs';

const root = new URL('../', import.meta.url).pathname;
const bannedLabels = new Set(['submit', 'ok', 'process']);
const statusVocabularySource = new URL('../packages/ui/src/status-vocabulary.ts', import.meta.url);

/**
 * The registry is plain data with no runtime dependency, so it is transpiled and
 * evaluated here rather than imported from `dist`. That keeps `ui:check` runnable on a
 * clean checkout, before any package build.
 */
export function loadStatusVocabulary(source) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
    fileName: 'status-vocabulary.ts',
  });
  if (diagnostics?.length) throw new Error(`status-vocabulary.ts does not transpile: ${diagnostics[0].messageText}`);
  const module = { exports: {} };
  new Function('exports', 'module', outputText)(module.exports, module);
  return module.exports;
}

/**
 * UX-002.AC01 / UX-002.AC05 completeness: the registry must cover every state of the
 * state unions the shipped contracts expose, and every label must be presentable copy.
 * The registry is loaded from the built package so the runtime BFF and this gate read
 * exactly the same table.
 */
export async function checkStatusVocabulary() {
  const issues = [];
  let registry;
  try {
    registry = loadStatusVocabulary(await readFile(statusVocabularySource, 'utf8'));
  } catch (error) {
    return [`packages/ui/src/status-vocabulary.ts: could not load the status registry (${error.message}).`];
  }
  const { statusVocabulary, derivedStatusVocabulary, missingStatusVocabularyEntries, pendingStatusLabels, statusTones, derivedStatusTones, frontlineRole } = registry;
  const seen = new Set();
  for (const row of statusVocabulary) {
    const key = `${row.stcCode}|${row.state}|${row.role ?? ''}`;
    if (seen.has(key)) issues.push(`packages/ui/src/status-vocabulary.ts: duplicate registry key ${key} (UX-002.AC01).`);
    seen.add(key);
    if (!statusTones.includes(row.tone)) {
      issues.push(`packages/ui/src/status-vocabulary.ts: ${key} uses tone "${row.tone}" outside {${statusTones.join(', ')}} (UX-002.BR02).`);
    }
    // UX-002.BR03 / NC03: no label may carry a raw technical code such as IN_PROGRESS.
    if (/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/.test(`${row.label} ${row.description}`)) {
      issues.push(`packages/ui/src/status-vocabulary.ts: ${key} copy contains a technical code (UX-002.BR03).`);
    }
    if (/\d/.test(row.label)) {
      issues.push(`packages/ui/src/status-vocabulary.ts: ${key} label contains a digit instead of Indonesian copy (UX-002.BR03).`);
    }
  }
  for (const [key, row] of Object.entries(derivedStatusVocabulary)) {
    if (!derivedStatusTones.includes(row.tone)) {
      issues.push(`packages/ui/src/status-vocabulary.ts: derived ${key} uses tone "${row.tone}" (UX-002.BR02).`);
    }
    for (const placeholder of row.placeholders) {
      if (!row.labelTemplate.includes(`{${placeholder}}`)) {
        issues.push(`packages/ui/src/status-vocabulary.ts: derived ${key} declares unused placeholder ${placeholder}.`);
      }
    }
  }
  const unions = await readStatusStateUnions();
  for (const missing of missingStatusVocabularyEntries(unions)) {
    issues.push(`packages/ui/src/status-vocabulary.ts: ${missing.stcCode}.${missing.state} has no status label; add one to PRD Appendix M or an explicit pendingStatusLabels entry (UX-002.E1, GAP-23).`);
  }
  const known = new Set(unions.flatMap(({ stcCode, states }) => states.map((state) => `${stcCode}|${state}`)));
  for (const row of statusVocabulary) {
    if (!row.reason && !known.has(`${row.stcCode}|${row.state}`) && !approvedAppendixMAggregates.has(row.stcCode)) {
      issues.push(`packages/ui/src/status-vocabulary.ts: ${row.stcCode}.${row.state} is registered but no shipped state union or Appendix M aggregate declares it (UX-002.NC02).`);
    }
  }
  for (const row of pendingStatusLabels) {
    if (!known.has(`${row.stcCode}|${row.state}`)) {
      issues.push(`packages/ui/src/status-vocabulary.ts: pendingStatusLabels lists ${row.stcCode}.${row.state}, which no shipped state union declares.`);
    }
    if (!row.reason?.trim()) {
      issues.push(`packages/ui/src/status-vocabulary.ts: pendingStatusLabels entry ${row.stcCode}.${row.state} needs a reason (AGT §18).`);
    }
  }
  if (statusVocabulary.some((row) => row.role && row.role !== frontlineRole)) {
    issues.push(`packages/ui/src/status-vocabulary.ts: only "${frontlineRole}" role labels are registered (UX-002.A1).`);
  }
  return issues;
}

/** Aggregates that PRD Appendix M labels but that have no shipped contract schema yet. */
const approvedAppendixMAggregates = new Set([
  'SalesOrder', 'FulfillmentRequest', 'DeliveryOrder', 'Invoice', 'Receivable', 'Payment',
  'CashCustody', 'WarehouseTask', 'DeliveryAttempt', 'ProofOfDelivery', 'Journal',
  'AccountingPeriod', 'StagingRecord', 'SyncBatch', 'OrderRequest', 'Visit', 'OutletLocation',
  'PosShift', 'PosSale', 'PosTender', 'Sync',
]);

/**
 * The state unions the shipped `@pss/contracts` schemas expose, and the `stcCode` each
 * one is registered under. `file` is the module under `packages/contracts/src/api/` and
 * `schema` the exported Zod schema whose `z.enum([...])` is read.
 */
export const statusStateUnions = [
  { stcCode: 'PosShift', file: 'pos-shift', schema: 'PosShiftStatusSchema' },
  { stcCode: 'PosSale', file: 'pos-sale', schema: 'PosSaleStatusSchema' },
  { stcCode: 'PosTender', file: 'pos-tender', schema: 'PosTenderResponseSchema' },
  { stcCode: 'PosTerminal', file: 'pos-terminal', schema: 'PosTerminalResponseSchema' },
  { stcCode: 'KasirCatalogItem', file: 'pos-kasir-bff', schema: 'KasirKatalogItemSchema' },
  { stcCode: 'Sync', file: 'pos-offline', schema: 'PosOfflineSaleResultSchema' },
  { stcCode: 'PosOfflineBatch', file: 'pos-offline', schema: 'SyncPosOfflineBatchResponseSchema' },
  { stcCode: 'WarehouseTask', file: 'wms-task', schema: 'WarehouseTaskStatusSchema' },
  { stcCode: 'WarehouseLocation', file: 'wms-location', schema: 'SetWarehouseLocationStatusRequestSchema' },
  { stcCode: 'StockDiscrepancy', file: 'wms-discrepancy', schema: 'ResolveStockDiscrepancyResponseSchema' },
  { stcCode: 'ExceptionItem', file: 'wms-operations', schema: 'ExceptionQueueItemSchema' },
  { stcCode: 'WmsOfflineSync', file: 'wms-fulfillment', schema: 'SyncedOfflineConfirmationsResponseSchema' },
];

const statusFieldNames = new Set(['status', 'outcome']);

/** Collect the string members of a `z.enum([...])` call. */
function enumStates(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const [argument] = node.arguments;
  if (!ts.isArrayLiteralExpression(argument)) return undefined;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'enum') return undefined;
  const states = argument.elements
    .filter((element) => ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))
    .map((element) => element.text);
  return states.length ? states : undefined;
}

/**
 * UX-002.AC01: read a state union out of a contract schema, whether the schema is
 * itself a `z.enum` (a named state union) or an object with a `status` / `outcome` field.
 */
export function readStatusStates(source, fileName, schema) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let states;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === schema && node.initializer) {
      states ??= enumStates(node.initializer);
      if (states) return;
      const objectLiteral = ts.isObjectLiteralExpression(node.initializer) ? node.initializer
        : ts.isCallExpression(node.initializer) && node.initializer.arguments[0] && ts.isObjectLiteralExpression(node.initializer.arguments[0])
          ? node.initializer.arguments[0] : undefined;
      for (const property of objectLiteral?.properties ?? []) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (!ts.isIdentifier(property.name) || !statusFieldNames.has(property.name.text)) continue;
        states ??= enumStates(property.initializer);
        if (states) return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return states;
}

export async function readStatusStateUnions() {
  const apiDirectory = new URL('../packages/contracts/src/api/', import.meta.url);
  const unions = [];
  for (const { stcCode, file, schema } of statusStateUnions) {
    const source = await readFile(new URL(`${file}.ts`, apiDirectory), 'utf8');
    const states = readStatusStates(source, `${file}.ts`, schema);
    if (!states?.length) throw new Error(`Status union ${schema} not found in packages/contracts/src/api/${file}.ts.`);
    unions.push({ stcCode, states });
  }
  return unions;
}

export function checkUiSource({ path, source }) {
  const issues = [];
  if (/#[0-9a-fA-F]{3,8}\b/.test(source) && !/packages\/ui\/(?:src\/tokens\.ts|tokens\.css)$/.test(path)) {
    issues.push(`${path}: use @pss/ui color tokens instead of a raw hex value (UX-001.AC01).`);
  }
  if (!/\.[jt]sx$/.test(path)) return issues;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxText(node) && /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(node.text)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      issues.push(`${path}:${line}: display a registered Indonesian status label instead of a raw enum (PLT-002.AC06).`);
    }
    if (ts.isJsxExpression(node) && node.parent && ts.isJsxElement(node.parent) && node.expression &&
        ts.isPropertyAccessExpression(node.expression) && ['state', 'status'].includes(node.expression.name.text)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      issues.push(`${path}:${line}: map state/status to the registered UI label before rendering (PLT-002.AC06).`);
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'button') {
      const label = node.children.filter(ts.isJsxText).map((child) => child.text).join(' ').trim().toLowerCase();
      if (bannedLabels.has(label)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        issues.push(`${path}:${line}: button label "${label}" is not actionable Indonesian copy (UX-001.AC02).`);
      }
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === 'Button') {
      const label = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === 'label');
      if (label && ts.isJsxAttribute(label) && label.initializer && ts.isStringLiteral(label.initializer)) {
        const value = label.initializer.text.trim().toLowerCase();
        if (bannedLabels.has(value)) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          issues.push(`${path}:${line}: button label "${value}" is not actionable Indonesian copy (UX-001.AC02).`);
        }
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
  const issues = [...files.flatMap(checkUiSource), ...await checkStatusVocabulary()];
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`UX-001/UX-002 UI lint: OK (${files.length} files, status registry complete).\n`);
}
