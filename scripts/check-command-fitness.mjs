import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { registeredControllerNames } from './check-api-controller-registration.mjs';

/**
 * PLT-002 / PLT-006 command fitness.
 *
 * The controller allow-list in `check-api-controller-registration.mjs` only proves
 * that a controller was reviewed. It cannot tell whether an individual route is
 * actually safe, so a new mutating route could satisfy that check while skipping
 * every control AGENTS.md requires. This gate inspects each mutating route of each
 * *registered* controller and requires three things that AGENTS.md demands per
 * protected mutation:
 *
 *   1. caller   — the acting user is resolved from the Authorization header, so a
 *                 route can never accept a client-supplied organization or actor id.
 *   2. body     — a `@Body()` parameter is validated by `ZodValidationPipe`. A raw
 *                 or untyped body is a violation, not a style preference.
 *   3. key      — an `Idempotency-Key` is read before the command runs, so a retry
 *                 replays instead of re-executing.
 *
 * Rule 3 may be waived only by an entry in `command-fitness-exemptions.json` that
 * states a verified reason. Read routes are out of scope; the health probes are not
 * commands.
 */

const MUTATING_VERBS = new Set(['Post', 'Put', 'Patch', 'Delete']);

function decoratorCall(node) {
  if (!node || !ts.isDecorator(node) || !ts.isCallExpression(node.expression)) return undefined;
  const callee = node.expression.expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function controllerPrefix(node) {
  for (const decorator of ts.getDecorators(node) ?? []) {
    if (decoratorCall(decorator) !== 'Controller') continue;
    const argument = decorator.expression.arguments[0];
    return argument && ts.isStringLiteral(argument) ? argument.text : '';
  }
  return undefined;
}

/** Route paths declared on a method by a mutating HTTP decorator. */
function mutatingRoutes(node) {
  const routes = [];
  for (const decorator of ts.getDecorators(node) ?? []) {
    const verb = decoratorCall(decorator);
    if (!verb || !MUTATING_VERBS.has(verb)) continue;
    const argument = decorator.expression.arguments[0];
    routes.push({ verb: verb.toUpperCase(), path: argument && ts.isStringLiteral(argument) ? argument.text : '' });
  }
  return routes;
}

/** Every callee name and every `...authorization` reference in a method, ignoring comments and types. */
function methodBehaviour(node) {
  const calls = new Set();
  let readsAuthorizationHeader = false;

  function visit(child) {
    if (ts.isPropertyAccessExpression(child) && child.name.text === 'authorization') readsAuthorizationHeader = true;
    if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
      const callee = child.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) calls.add(callee.name.text);
      else if (ts.isIdentifier(callee)) calls.add(callee.text);
      // `@Body(new ZodValidationPipe(Schema))` parses as a NewExpression inside a decorator.
      if (ts.isNewExpression(child) && ts.isIdentifier(child.expression) && child.expression.text.endsWith('Pipe')) {
        calls.add(child.expression.text);
      }
    }
    ts.forEachChild(child, visit);
  }

  for (const parameter of node.parameters) visit(parameter);
  if (node.body) visit(node.body);
  return { calls, readsAuthorizationHeader };
}

/** True when the method resolves the caller rather than trusting a request field. */
function resolvesCaller(behaviour) {
  return behaviour.readsAuthorizationHeader || [...behaviour.calls].some((name) => /^(get)?currentUser$/i.test(name));
}

/** A route that mutates state must read a client-supplied idempotency key. */
function readsIdempotencyKey(behaviour) {
  return [...behaviour.calls].some((name) => /idempotencyKey/i.test(name));
}

/** Every `@Body()` parameter must be validated by the shared Zod pipe. */
function unvalidatedBodies(node) {
  const unvalidated = [];
  for (const parameter of node.parameters) {
    for (const decorator of ts.getDecorators(parameter) ?? []) {
      if (decoratorCall(decorator) !== 'Body') continue;
      const usesZodPipe = (decorator.expression.arguments ?? []).some((argument) =>
        ts.isNewExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === 'ZodValidationPipe');
      if (!usesZodPipe) unvalidated.push(parameter.name.getText());
    }
  }
  return unvalidated;
}

function exemptionKey(verb, path) {
  return `${verb} ${path}`;
}

/**
 * `registered` is the set of controller names the API module registers; when given, any other
 * controller is skipped, because it serves no route. When omitted, every controller is inspected.
 */
export function findCommandFitnessProblems(sources, exemptions, registered) {
  const problems = [];
  const waives = new Map();

  for (const exemption of exemptions.exemptions ?? []) {
    if (!exemption.method || !exemption.path || !exemption.rule || !exemption.reason) {
      problems.push(`Malformed exemption entry: ${JSON.stringify(exemption)}. Every entry needs method, path, rule, and a verified reason.`);
      continue;
    }
    waives.set(`${exemptionKey(exemption.method.toUpperCase(), exemption.path)}::${exemption.rule}`, exemption);
  }

  for (const { fileName, source } of sources) {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

    function visit(node) {
      if (ts.isClassDeclaration(node)) {
        const prefix = controllerPrefix(node);
        if (prefix !== undefined && (!registered || registered.has(node.name?.text))) {
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            const methodName = member.name?.getText() ?? '(anonymous)';
            const behaviour = methodBehaviour(member);
            for (const route of mutatingRoutes(member)) {
              const fullPath = `/${[prefix, route.path].filter(Boolean).join('/')}`;
              const label = `${exemptionKey(route.verb, fullPath)} (${node.name?.text ?? 'Controller'}#${methodName})`;
              const findings = [];

              if (!resolvesCaller(behaviour)) findings.push('does not resolve the acting user from the Authorization header');
              const unvalidated = unvalidatedBodies(member);
              if (unvalidated.length) findings.push(`accepts an unvalidated @Body parameter: ${unvalidated.join(', ')}`);
              if (!readsIdempotencyKey(behaviour) && !waives.has(`${exemptionKey(route.verb, fullPath)}::idempotency`)) {
                findings.push('mutates state without reading an Idempotency-Key (PLT-006); add one or a reviewed entry in scripts/command-fitness-exemptions.json');
              }

              for (const finding of findings) problems.push(`${label} ${finding}.`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(file);
  }
  return problems;
}

/**
 * AGENTS.md §14 / §3.6: a mutation commits exactly once and leaves an audit trail. That holds
 * only if there is a single write path, so these rules police the *transaction plumbing* rather
 * than the routes. Each one exists because the shape it rejects was present in this repository:
 *
 *   one-pipeline   — `runCommand` is the only exported entry to a retriable mutation. Reaching
 *                    for `withIdempotentCommand` directly reinstates the transaction-runner
 *                    injection point that made the audit guarantee opt-in.
 *   single-audit   — the audited-transaction helper is solved once, in `@pss/platform`. Three
 *                    per-domain copies of `withConnection` had already drifted apart in their
 *                    comments, and twelve domains have no files yet.
 *   audit-exempted — `runCommandWithoutAudit` is legitimate for a batch or for presence
 *                    telemetry, and illegitimate for everything else. Each use is listed here
 *                    with its justification so the list stays short and reviewable.
 */

const UNAUDITED_REASON_MINIMUM = 20;

/** The canonical definitions are the only place a pipeline primitive may be written. */
const CANONICAL_PIPELINE = [
  'domains/platform/src/application/command.ts',
  'domains/platform/src/application/idempotency.ts',
];

/** Sources that legitimately mention a primitive without calling it. */
const DEFINES_OR_REEXPORTS = [...CANONICAL_PIPELINE, 'domains/platform/src/index.ts'];

/** Every TypeScript source in the workspace, as `{ relative, source }`. */
export async function collectWorkspaceSources(root) {
  const collected = [];
  const prefix = new URL('', root).pathname;

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.turbo', 'coverage', '.next'].includes(entry.name)) continue;
        await walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        collected.push({ relative: full.replace(prefix, ''), source: await readFile(full, 'utf8') });
      }
    }
  }

  for (const name of ['apps', 'domains', 'packages']) await walk(join(prefix, name));
  return collected;
}

export function findPlumbingProblemsIn(sources) {
  const problems = [];
  const notes = [];

  for (const { relative, source } of sources) {
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
    const isCanonical = CANONICAL_PIPELINE.some((path) => relative.endsWith(path));
    const isDefinition = DEFINES_OR_REEXPORTS.some((path) => relative.endsWith(path));
    const isTest = relative.includes('/tests/') || relative.includes('.test.ts');

    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'withIdempotentCommand') {
          if (isCanonical) continue;
          problems.push(
            `${relative} imports \`withIdempotentCommand\`, which accepts a transaction runner and so makes the audit guarantee opt-in. Use \`runCommand\` from @pss/platform.`,
          );
        }
        if (imported === 'withConnection' && /from '\.\/support\/with-connection'/.test(specifier)) {
          problems.push(
            `${relative} imports its own \`withConnection\`. The audited-transaction helper is solved once in @pss/platform; a per-domain copy is a second implementation of the same concern.`,
          );
        }
      }
    }

    // A local definition of either primitive is the same violation as importing one.
    for (const statement of tree.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
      if (statement.name.text !== 'withConnection' && statement.name.text !== 'withIdempotentCommand') continue;
      if (isCanonical) continue;
      problems.push(
        `${relative} defines its own \`${statement.name.text}\`. The command pipeline is solved once in @pss/platform; reimplementing it here is how the same concern ends up solved two ways.`,
      );
    }

    // Call sites are read from the AST: a regex cannot tell a justification from any other
    // long string literal that happens to follow the call.
    if (!isDefinition && !isTest) {
      const exempt = [];
      function findCalls(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === 'runCommandWithoutAudit') {
          exempt.push(node);
        }
        ts.forEachChild(node, findCalls);
      }
      findCalls(tree);
      for (const call of exempt) {
        const justification = call.arguments[3];
        if (!justification || !ts.isStringLiteral(justification)
          || justification.text.trim().length < UNAUDITED_REASON_MINIMUM) {
          problems.push(
            `${relative} calls \`runCommandWithoutAudit\` without a string-literal justification of at least ${UNAUDITED_REASON_MINIMUM} characters as its fourth argument.`,
          );
          continue;
        }
        notes.push(`${relative}: ${justification.text.trim()}`);
      }
    }
  }
  return { problems, notes };
}

if (process.argv[1]?.endsWith('/check-command-fitness.mjs')) {
  const root = new URL('../', import.meta.url);
  const exemptions = JSON.parse(await readFile(new URL('scripts/command-fitness-exemptions.json', root), 'utf8'));
  const apiRoot = new URL('apps/api/src/', root);
  // Every source file, not a list: a hardcoded list let a controller in a file that was not on it
  // (pos.controller.ts) be registered with no route checked at all. Only registered controllers
  // are inspected, so reading an unregistered file costs nothing.
  const modules = (await readdir(apiRoot)).filter((name) => name.endsWith('.ts')).sort();
  const sources = [];
  for (const name of modules) sources.push({ fileName: name, source: await readFile(new URL(name, apiRoot), 'utf8') });
  const registered = registeredControllerNames(sources.find(({ fileName }) => fileName === 'main.ts').source);
  // A computed or missing controllers array cannot be narrowed statically, so inspect everything.
  const problems = findCommandFitnessProblems(sources, exemptions, registered);
  const plumbing = findPlumbingProblemsIn(await collectWorkspaceSources(root));
  const all = [...problems, ...plumbing.problems];

  if (all.length) {
    process.stderr.write(`PLT-002/PLT-006 command fitness violations:\n- ${all.join('\n- ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('PLT-002/PLT-006 command fitness: every registered mutating route resolves its caller, validates its body, carries an idempotency key, and reaches the database through the single command pipeline.\n');
    if (plumbing.notes.length) {
      process.stdout.write(`Commands exempt from the audit guard (${plumbing.notes.length}), each with a stated reason:\n- ${plumbing.notes.join('\n- ')}\n`);
    } else {
      process.stdout.write('No command is exempt from the audit guard.\n');
    }
  }
}
