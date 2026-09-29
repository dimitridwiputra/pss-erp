import { readFile } from 'node:fs/promises';
import ts from 'typescript';

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

export function findCommandFitnessProblems(sources, exemptions) {
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
        if (prefix !== undefined) {
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

if (process.argv[1]?.endsWith('/check-command-fitness.mjs')) {
  const root = new URL('../', import.meta.url);
  const exemptions = JSON.parse(await readFile(new URL('scripts/command-fitness-exemptions.json', root), 'utf8'));
  const apiRoot = new URL('apps/api/src/', root);
  const modules = ['main.ts', 'identity.controller.ts', 'approval.controller.ts', 'wms.controller.ts'];
  const sources = [];
  for (const name of modules) sources.push({ fileName: name, source: await readFile(new URL(name, apiRoot), 'utf8') });
  const problems = findCommandFitnessProblems(sources, exemptions);
  if (problems.length) {
    process.stderr.write(`PLT-002/PLT-006 command fitness violations:\n- ${problems.join('\n- ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('PLT-002/PLT-006 command fitness: every registered mutating route resolves its caller, validates its body, and carries an idempotency key.\n');
  }
}
