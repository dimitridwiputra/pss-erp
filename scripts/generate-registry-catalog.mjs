import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const prdPath = new URL('docs/PRODUCT_PRD.md', root);
const sourcePath = new URL('packages/contracts/src/registry/catalog.generated.ts', root);
const documentationPath = new URL('docs/registry/catalog.json', root);

function rowsBetween(markdown, start, end) {
  const section = markdown.split(start)[1]?.split(end)[0];
  if (!section) throw new Error(`Registry section ${start} not found.`);
  return section.split('\n').filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 1 && !cells.every((cell) => /^[-: ]+$/.test(cell)))
    .slice(1);
}

const unquote = (value) => value.replace(/^`|`$/g, '');
const codes = (value) => [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/**
 * A writable configuration key, by grammar.
 *
 * Namespaced lowercase, matching the `domain.resource.action` shape the PRD already uses for
 * permission codes. `tax.vat_output_rate` qualifies; `pss_mode` and `warehouse_id` do not, and that
 * is the whole point — backticks are a Markdown convention, not a statement that something is
 * configuration.
 */
const CONFIG_KEY_GRAMMAR = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export function isConfigKey(value) {
  return CONFIG_KEY_GRAMMAR.test(value);
}

/**
 * Appendix N.2 rows are classified by their `kind` column, never by whether the item cell happens
 * to contain backticks. A `Policy Field` row documents a PrincipalSystemPolicy attribute and is
 * recorded as documentation; it must never become a writable key, which is exactly how `pss_mode`
 * and `warehouse_id` became one.
 *
 * An unrecognised kind throws rather than being ignored: a new row type in the PRD is a decision
 * about whether it is writable, and defaulting it either way would guess.
 */
const WRITABLE_KINDS = new Set(['config', 'flag', 'config / flag']);
const NON_WRITABLE_KINDS = new Set(['policy field', 'policy', 'metadata', 'documentation']);

/**
 * The kind column is matched case-insensitively. Appendix N.2 wrote "Policy field" where this
 * generator expected "Policy Field", and the mismatch silently downgraded a non-writable row to an
 * unknown kind — which is the failure this whole check exists to prevent.
 */
function normaliseKind(kind) {
  return String(kind ?? '').trim().toLowerCase();
}

/** Keys from a writable N.2 row. Every extracted code must satisfy the grammar or this throws. */
function writableKeysIn(item, context) {
  return codes(item ?? '').map((code) => {
    if (!isConfigKey(code)) {
      throw new Error(
        `${context}: \`${code}\` is not a valid configuration key. A configuration key is namespaced `
        + 'lowercase, for example `tax.vat_output_rate`. If this is a policy field or an explanatory '
        + 'mention, give the row a non-writable kind (Policy Field) instead of relying on the key '
        + 'being rejected here.',
      );
    }
    return code;
  });
}

export function parseRegistryCatalog(markdown) {
  const roles = rowsBetween(markdown, '### D.1 Role Registry', '### D.2 Kelompok permission')
    .map(([code, label, product, defaultScope, permissionGroups, mfa]) => ({ code, label, product, defaultScope, permissionGroups, mfaRequired: mfa === '✔' }));
  const permissionGroups = rowsBetween(markdown, '### D.2 Kelompok permission', '### D.3 Permission & approval type tambahan')
    .map(([group, permissions]) => ({ group, permissions: codes(permissions ?? ''), sourceText: permissions }));
  const permissionAdditions = rowsBetween(markdown, '### D.3 Permission & approval type tambahan', '### D.4 Segregation of Duties')
    .filter(([kind]) => kind === 'Permission').map(([, item, section]) => ({ item, section, codes: codes(item ?? '') }));
  const approvalTypes = [...new Set(rowsBetween(markdown, '### D.3 Permission & approval type tambahan', '### D.4 Segregation of Duties')
    .filter(([kind]) => kind === 'Approval type').flatMap(([, item]) => codes(item ?? '')))];
  const baseErrors = rowsBetween(markdown, '### F.1 Kode dasar', '### F.2 Kode domain')
    .map(([code, httpCategory, description]) => ({ code: unquote(code), httpCategory, description }));
  const domainErrors = rowsBetween(markdown, '### F.2 Kode domain', '### F.3 Reason code')
    .map(([code, httpCategory, title, explanation, action, section]) => ({ code: unquote(code), httpCategory, title, explanation, action, section, copyComplete: Boolean(title && explanation && action) }));
  const reasonCodes = rowsBetween(markdown, '### F.3 Reason code', '## Appendix G')
    .flatMap(([area, values]) => codes(values ?? '').map((code) => ({ area, code, placeholder: code.endsWith('_') })));
  const statuses = rowsBetween(markdown, '## Appendix M — Status Vocabulary & UI Copy Registry', '### M.2 Status sinkronisasi offline')
    .filter((cells) => cells.length === 5).map(([aggregateState, desktopLabel, frontlineLabel, tone, icon]) => ({ aggregateState, desktopLabel, frontlineLabel, tone, icon: unquote(icon) }));
  const offlineStatuses = rowsBetween(markdown, '### M.2 Status sinkronisasi offline', '## Appendix N')
    .map(([code, label, tone, icon]) => ({ code: unquote(code), label, tone, icon: unquote(icon) }));
  // One canonical key per registry row. Appendix N.1 previously packed two keys into one cell
  // (`tax.vat_output_rate` / `tax.vat_input_rate`), which generated a single key matching neither:
  // both raised CONFIG_KEY_UNKNOWN and neither VAT rate could be configured. The PRD row is now one
  // key per line, and a cell that still holds several is a PRD defect worth failing on rather than
  // guessing which the author meant.
  const configurationSeeds = rowsBetween(markdown, '### N.1 Seed registry', '### N.2 Config & flag tambahan')
    .map(([keyCell, defaultText, scope, owner, validationGate], index) => {
      const found = codes(keyCell ?? '');
      if (found.length !== 1) {
        throw new Error(
          `Appendix N.1 row ${index + 1} must name exactly one configuration key, found `
          + `${found.length || 'none'} in "${keyCell}". Give each key its own row.`,
        );
      }
      const [key] = found;
      if (!isConfigKey(key)) {
        throw new Error(`Appendix N.1 row ${index + 1}: \`${key}\` is not a valid configuration key.`);
      }
      return { keyExpression: key, defaultText, scope, owner, validationGate };
    });
  const configurationAdditions = rowsBetween(markdown, '### N.2 Config & flag tambahan', '## Appendix O')
    .map(([kind, item, section], index) => {
      const context = `Appendix N.2 row ${index + 1} (kind "${kind}")`;
      const normalised = normaliseKind(kind);
      if (NON_WRITABLE_KINDS.has(normalised)) {
        return { kind, item, section, keys: [], documentedOnly: codes(item ?? '') };
      }
      if (!WRITABLE_KINDS.has(normalised)) {
        throw new Error(
          `${context}: unrecognised kind. Use Config, Flag, or Config / flag for a writable key, or `
          + 'Policy Field, Policy, Metadata, or Documentation for a documented-only field.',
        );
      }
      return { kind, item, section, keys: writableKeysIn(item, context) };
    });
  const queueSeeds = rowsBetween(markdown, '### P.1 Seed registry', '### P.2 Antrian tambahan')
    .map(([code, label, trigger, ownerRole, defaultSla, permittedActions, escalation]) => ({ code: unquote(code), label, trigger, ownerRole, defaultSla, permittedActions, escalation }));
  const queueAdditions = rowsBetween(markdown, '### P.2 Antrian tambahan', '\n---\n')
    .map(([kind, item, section]) => ({ kind, item, section, codes: codes(item ?? '') }));

  const catalog = { version: 1, source: 'docs/PRODUCT_PRD.md Appendices D, F, M, N, P', roles, permissionGroups, permissionAdditions, approvalTypes, baseErrors, domainErrors, reasonCodes, statuses, offlineStatuses, configurationSeeds, configurationAdditions, queueSeeds, queueAdditions };
  for (const [name, entries] of Object.entries(catalog)) {
    if (!Array.isArray(entries)) continue;
    if (!entries.length) throw new Error(`Registry ${name} is empty; review the PRD parser.`);
  }
  for (const [name, entries] of [['baseErrors', baseErrors], ['domainErrors', domainErrors], ['queueSeeds', queueSeeds]]) {
    const keys = entries.map(({ code }) => code);
    if (keys.length !== new Set(keys).size) throw new Error(`Duplicate code in ${name}.`);
  }
  const allErrorCodes = [...baseErrors, ...domainErrors].map(({ code }) => code);
  if (allErrorCodes.length !== new Set(allErrorCodes).size) throw new Error('Duplicate code across error registries.');
  return catalog;
}

if (process.argv[1]?.endsWith('/generate-registry-catalog.mjs')) {
  const catalog = parseRegistryCatalog(await readFile(prdPath, 'utf8'));
  const source = `// Generated from PRD Appendices D, F, M, N, P. Do not edit.\nexport const registryCatalog = ${JSON.stringify(catalog, null, 2)} as const;\n`;
  const documentation = `${JSON.stringify(catalog, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const [existingSource, existingDocumentation] = await Promise.all([
      readFile(sourcePath, 'utf8').catch(() => ''), readFile(documentationPath, 'utf8').catch(() => ''),
    ]);
    if (existingSource !== source || existingDocumentation !== documentation) {
      process.stderr.write('Registry catalog is out of sync with PRD Appendices D, F, M, N, P. Run node scripts/generate-registry-catalog.mjs.\n');
      process.exitCode = 1;
    } else process.stdout.write('Registry catalog matches PRD.\n');
  } else {
    await mkdir(new URL('packages/contracts/src/registry/', root), { recursive: true });
    await mkdir(new URL('docs/registry/', root), { recursive: true });
    await Promise.all([writeFile(sourcePath, source), writeFile(documentationPath, documentation)]);
    process.stdout.write('Generated source-preserving PRD registries.\n');
  }
}
