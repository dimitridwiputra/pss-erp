import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const approvedControllers = new Set([
  'HealthController',
  'IdentityController',
  'IdentityAdminController',
  'ApprovalController',
  'WmsController',
]);

export function findUnapprovedApiControllers(source) {
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
  const violations = findUnapprovedApiControllers(await readFile(mainPath, 'utf8'));
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('API controller registration: approved foundation routes only.\n');
  }
}
