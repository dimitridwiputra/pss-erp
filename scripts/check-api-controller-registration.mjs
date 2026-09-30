import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const approvedControllers = new Set([
  'HealthController',
  'IdentityController',
  'IdentityAdminController',
  'ApprovalController',
  'WmsController',
  // Back office (MVP §6.3). Each is a thin boundary over its own domain: caller from the session,
  // the permission at the record's own scope, a required Idempotency-Key on every mutation.
  'BackofficeProductController',
  'BackofficePriceListController',
  'BackofficeStockController',
]);

/**
 * Controllers that may be registered only behind a server-side switch (MVP-OD-5). Registration is
 * allowed when the controller class itself carries `@UseGuards(<guard>, ...)`: a class-level guard
 * covers every route, including one added later, and runs before any pipe or handler.
 */
export const guardedControllers = {
  PosController: { file: 'apps/api/src/pos.controller.ts', guard: 'DemoPosFeatureGuard' },
  CounterBackofficeController: { file: 'apps/api/src/counter-backoffice.controller.ts', guard: 'DemoPosFeatureGuard' },
};

export function hasClassLevelGuard(source, className, guard) {
  const file = ts.createSourceFile('controller.ts', source, ts.ScriptTarget.Latest, true);
  let guarded = false;
  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      guarded = (ts.getDecorators(node) ?? []).some((decorator) =>
        ts.isCallExpression(decorator.expression) &&
        ts.isIdentifier(decorator.expression.expression) && decorator.expression.expression.text === 'UseGuards' &&
        decorator.expression.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === guard));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return guarded;
}

/** The identifiers in `@Module({ controllers: [...] })`, or `undefined` when the array is missing or computed. */
export function registeredControllerNames(source) {
  const file = ts.createSourceFile('apps/api/src/main.ts', source, ts.ScriptTarget.Latest, true);
  let names;
  function visit(node) {
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Module') {
      const options = node.expression.arguments[0];
      const controllers = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) => ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) && property.name.text === 'controllers')
        : undefined;
      if (controllers && ts.isPropertyAssignment(controllers) && ts.isArrayLiteralExpression(controllers.initializer) &&
          controllers.initializer.elements.every((element) => ts.isIdentifier(element))) {
        names = new Set([...(names ?? []), ...controllers.initializer.elements.map((element) => element.text)]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return names;
}

/** `controllerSources` maps a guarded controller's name to its source text. */
export function findUnapprovedApiControllers(source, controllerSources = {}) {
  const file = ts.createSourceFile('apps/api/src/main.ts', source, ts.ScriptTarget.Latest, true);
  const violations = [];
  let foundModule = false;

  function visit(node) {
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Module') {
      foundModule = true;
      const options = node.expression.arguments[0];
      const controllers = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) => ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) && property.name.text === 'controllers')
        : undefined;
      if (!controllers || !ts.isPropertyAssignment(controllers) || !ts.isArrayLiteralExpression(controllers.initializer)) {
        violations.push('API module must declare an explicit controllers array.');
      } else {
        for (const controller of controllers.initializer.elements) {
          const guarded = ts.isIdentifier(controller) ? guardedControllers[controller.text] : undefined;
          if (guarded) {
            const controllerSource = controllerSources[controller.text];
            if (controllerSource === undefined || !hasClassLevelGuard(controllerSource, controller.text, guarded.guard)) {
              violations.push(`${controller.text} may be registered only with a class-level @UseGuards(${guarded.guard}) in ${guarded.file} (MVP-OD-5).`);
            }
            continue;
          }
          if (!ts.isIdentifier(controller) || !approvedControllers.has(controller.text)) {
            violations.push(`Unapproved API controller ${controller.getText(file)}: complete RBAC-002 and PLT-006 route checks before registration.`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  if (!foundModule) violations.push('API module registration is missing.');
  return violations;
}

if (process.argv[1]?.endsWith('/check-api-controller-registration.mjs')) {
  const mainPath = new URL('../apps/api/src/main.ts', import.meta.url);
  const controllerSources = Object.fromEntries(await Promise.all(Object.entries(guardedControllers).map(async ([name, { file }]) =>
    [name, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')])));
  const violations = findUnapprovedApiControllers(await readFile(mainPath, 'utf8'), controllerSources);
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('API controller registration: approved foundation routes only.\n');
  }
}
