import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { checkEventSchemaCompatibility, checkOpenApiCompatibility } from './compatibility.mjs';
import { readContractDocumentFromGit } from './git-contract-baseline.mjs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { HealthResponseSchema, CurrentUserResponseSchema, ProblemDetailsSchema, eventCatalog, eventSchemaRegistry } = require('../dist');
const root = new URL('../../../', import.meta.url);

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createDocuments() {
  const registered = Object.entries(eventSchemaRegistry).flatMap(([name, versions]) =>
    Object.entries(versions).map(([version, schema]) => ({ name, version: Number(version), schema: z.toJSONSchema(schema) })),
  );
  const names = new Set(eventCatalog.map((entry) => entry.name));
  for (const event of registered) {
    if (!names.has(event.name)) throw new Error(`Registered event ${event.name} is absent from Appendix C.`);
    if (!Number.isInteger(event.version) || event.version < 1) throw new Error(`Invalid version for ${event.name}.`);
  }
  const response = z.toJSONSchema(HealthResponseSchema);
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'PSS Operating Platform API', version: '0.1.0' },
    paths: {
      ...Object.fromEntries(['/health/live', '/health/ready'].map((path) => [path, {
        get: {
          operationId: path === '/health/live' ? 'getLiveness' : 'getReadiness',
          responses: {
            '200': { description: 'Process health', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } } },
            default: { description: 'Problem details', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } } },
          },
        },
      }])),
      '/me': {
        get: {
          operationId: 'getCurrentUser',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Active PSS account', content: { 'application/json': { schema: { $ref: '#/components/schemas/CurrentUserResponse' } } } },
            default: { description: 'Problem details', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } } },
          },
        },
      },
    },
    components: {
      schemas: { HealthResponse: response, CurrentUserResponse: z.toJSONSchema(CurrentUserResponseSchema), ProblemDetails: z.toJSONSchema(ProblemDetailsSchema) },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
  };
  return {
    'docs/api/openapi.json': openapi,
    'docs/events/catalog.json': {
      source: 'docs/PRODUCT_PRD.md Appendix C',
      totalTypes: eventCatalog.length,
      registeredVersions: registered.map(({ name, version }) => ({ name, version })),
      events: eventCatalog,
    },
    'docs/events/schemas.json': {
      description: 'Only listed type/version pairs have validated payload contracts and may be published.',
      schemas: Object.fromEntries(registered.map(({ name, version, schema }) => [`${name}@${version}`, schema])),
    },
  };
}

const documents = createDocuments();
const check = process.argv.includes('--check');
for (const [relativePath, value] of Object.entries(documents)) {
  const path = new URL(relativePath, root);
  const rendered = toJson(value);
  if (check) {
    const existing = await readFile(path, 'utf8').catch(() => '');
    if (existing !== rendered) throw new Error(`${relativePath} is stale. Run pnpm --filter @pss/contracts build.`);
  } else {
    await mkdir(new URL('.', path), { recursive: true });
    await writeFile(path, rendered);
  }
}
if (check) {
  const baselinePath = new URL('docs/events/schema-baseline.json', root);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  checkEventSchemaCompatibility(baseline, documents['docs/events/schemas.json']);
  const apiBaseline = JSON.parse(await readFile(new URL('docs/api/openapi-baseline.json', root), 'utf8'));
  checkOpenApiCompatibility(apiBaseline, documents['docs/api/openapi.json']);
  const baseRef = process.env.PSS_CONTRACT_BASE_REF;
  if (baseRef) {
    const cwd = fileURLToPath(root);
    const baseEvents = readContractDocumentFromGit(baseRef, 'docs/events/schemas.json', cwd);
    const baseApi = readContractDocumentFromGit(baseRef, 'docs/api/openapi.json', cwd);
    checkEventSchemaCompatibility(baseEvents, documents['docs/events/schemas.json']);
    checkOpenApiCompatibility(baseApi, documents['docs/api/openapi.json']);
  }
  process.stdout.write(`Generated contract documents match source; event and API contracts are backward compatible with checked-in baselines${baseRef ? ` and ${baseRef}` : ''}.\n`);
} else {
  process.stdout.write('Generated OpenAPI and event catalog/schema documents.\n');
}
