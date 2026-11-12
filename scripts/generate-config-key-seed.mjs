import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { registryCatalog } = require('../packages/contracts/dist/index.js');

const MIGRATION = 'domains/platform/infrastructure/database/migrations/0010_config_key_registry.sql';
const SEED_HEADER = '-- PLT-009 key classification seed. GENERATED, not hand-maintained.';

/**
 * PLT-009 configuration key classifier.
 *
 * `platform.config_key` is the authoritative answer to "who may change this key, and does it need
 * approval". It has to cover every registered key, because an unclassified key raises
 * CONFIG_KEY_UNKNOWN and the write path fails closed. Deriving the seed from the generated
 * registry — the same source the runtime reads — is what stops a key added to Appendix N from
 * being left unowned, which is the failure that made the write path unreachable in the first place.
 *
 * Run with `--check` to fail when the committed migration is stale, so drift is a CI failure
 * rather than a runtime surprise.
 */
const KEYS = [...new Set([
  ...registryCatalog.configurationSeeds.map((entry) => entry.keyExpression),
  ...registryCatalog.configurationAdditions.flatMap((entry) => entry.keys ?? []),
])].filter((key) => key && !key.includes('`'));

/** Owner role per namespace, from the roles Appendix D.1 already registers. */
const OWNER = {
  finance: 'FINANCE_MAKER', tax: 'CONTROLLER', credit: 'AR_OFFICER', ar: 'AR_OFFICER',
  payments: 'FINANCE_MAKER', procurement: 'PROCUREMENT_OFFICER', invoicing: 'FINANCE_MAKER',
  inventory: 'WAREHOUSE_ADMIN', orders: 'SALES_ADMIN', fulfillment: 'WAREHOUSE_ADMIN',
  returns: 'AR_OFFICER', commercial: 'COMMERCIAL_ADMIN', sfa: 'SALES_SUPERVISOR',
  wms: 'WAREHOUSE_ADMIN', fleet: 'FLEET_ADMIN', pos: 'POS_SUPERVISOR', geo: 'GIS_ADMIN',
  master_data: 'MASTER_DATA_STEWARD', principal_policy: 'COMMERCIAL_ADMIN',
  identity: 'SYSTEM_ADMIN', approval: 'CFO', supervisor: 'SALES_SUPERVISOR',
  reporting: 'SALES_SUPERVISOR',
};

/** Platform behaviour a system administrator legitimately owns. */
const TECHNICAL_PREFIX = [
  'integration.', 'idempotency.', 'events.', 'dwh.', 'api.', 'observability.', 'backup.',
  'migration.', 'media.', 'notifications.', 'platform.',
];
const TECHNICAL_EXACT = new Set([
  'audit.retention_years', 'audit.hot_months', 'documents.reservation_timeout_minutes',
  'offline.max_age_hours', 'offline.max_retry',
]);

/**
 * Changes money owed, tax computed, or credit exposure.
 *
 * The inventory and POS entries are named rather than prefixed because those namespaces are mostly
 * operational: `inventory.reservation_expiry_hours` is routine, while `inventory.costing_method`
 * restates stock value. A prefix rule alone would classify both the same way and be wrong about one.
 */
const SENSITIVE_PREFIX = [
  'finance.', 'tax.', 'credit.', 'ar.', 'payments.', 'procurement.', 'invoicing.', 'approval.',
];
const SENSITIVE_EXACT = new Set([
  'inventory.costing_method', 'inventory.valuation_unit', 'inventory.cost_precision',
  'inventory.transit_max_days', 'orders.auto_confirm', 'pos.enabled', 'pos.credit_sale',
  'pos.price_list_scope', 'pos.receipt.format', 'pos.walk_in_customer_id',
  'pos.shift.open_float_amount', 'pos.shift.close_tolerance', 'pos.transfer.release_rule',
  'pos.offline.max_sale_amount', 'principal_policy.external_order_app_link',
  'identity.sod_exception',
]);

const NAMESPACE_LABEL = {
  finance: 'Keuangan', tax: 'Pajak', credit: 'Kredit', ar: 'Piutang', payments: 'Pembayaran',
  procurement: 'Pengadaan', invoicing: 'Faktur', inventory: 'Persediaan', orders: 'Pesanan',
  fulfillment: 'Fulfillment', returns: 'Retur', commercial: 'Komersial', sfa: 'SFA',
  wms: 'Gudang', fleet: 'Armada', pos: 'POS', geo: 'Geo', master_data: 'Data Induk',
  principal_policy: 'Kebijakan Principal', identity: 'Identitas', approval: 'Persetujuan',
  supervisor: 'Supervisor', reporting: 'Pelaporan', integration: 'Integrasi',
  idempotency: 'Idempotensi', events: 'Event', dwh: 'Data Warehouse', api: 'API',
  observability: 'Observability', backup: 'Backup', migration: 'Migrasi', media: 'Media',
  notifications: 'Notifikasi', platform: 'Platform', documents: 'Dokumen', audit: 'Audit',
  offline: 'Offline',
};

const description = (key) => {
  const namespace = key.split('.')[0];
  const leaf = key.split('.').slice(1).join('.').replaceAll('_', ' ');
  return `Konfigurasi ${NAMESPACE_LABEL[namespace] ?? namespace}: ${leaf}.`;
};

function classify(key) {
  const isTechnical = TECHNICAL_PREFIX.some((prefix) => key.startsWith(prefix)) || TECHNICAL_EXACT.has(key);
  const isSensitive = SENSITIVE_PREFIX.some((prefix) => key.startsWith(prefix)) || SENSITIVE_EXACT.has(key);
  // Fail loudly rather than let a prefix decide: a technical key that can change money would give
  // SYSTEM_ADMIN unilateral authority over an amount, which is exactly what SOD-07 forbids.
  if (isTechnical && isSensitive) {
    throw new Error(`${key} is in a technical namespace but changes money. Classify it explicitly.`);
  }
  if (isTechnical) return { classification: 'TECHNICAL', sensitivity: 'ROUTINE', owner: null };
  const owner = OWNER[key.split('.')[0]];
  if (!owner) {
    throw new Error(`No owner role registered for namespace of ${key}. Add one rather than leaving the key unowned.`);
  }
  return { classification: 'BUSINESS', sensitivity: isSensitive ? 'SENSITIVE' : 'ROUTINE', owner };
}

const classified = KEYS.map((key) => ({ key, ...classify(key) }))
  .sort((a, b) => a.key.localeCompare(b.key));

/** One VALUES row, without the separating comma: the caller owns the join. */
const row = ({ key, classification, sensitivity, owner }) =>
  `  ('${key}', '${classification}', '${sensitivity}', ${owner ? `'${owner}'` : 'NULL'}, '${description(key)}')`;

const technicalRows = classified.filter((entry) => entry.classification === 'TECHNICAL').map(row);
const businessRows = (sensitivity) => {
  const byOwner = new Map();
  for (const entry of classified.filter((e) => e.classification === 'BUSINESS' && e.sensitivity === sensitivity)) {
    const bucket = byOwner.get(entry.owner) ?? [];
    bucket.push(row(entry));
    byOwner.set(entry.owner, bucket);
  }
  return [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, rows]) => rows);
};

const seedRows = [...technicalRows, ...businessRows('SENSITIVE'), ...businessRows('ROUTINE')];

const summary = {
  technical: technicalRows.length,
  sensitive: businessRows('SENSITIVE').length,
  routine: businessRows('ROUTINE').length,
  total: classified.length,
};

const INSERT = 'INSERT INTO platform.config_key (key, classification, sensitivity, owner_role_code, description) VALUES';

const SEED_BLOCK = [
  SEED_HEADER,
  '-- `pnpm config-keys:seed` derives these rows from the same generated registry the runtime reads,',
  '-- and `--check` runs in CI, so a key added to Appendix N cannot be left unclassified — which is',
  '-- the failure that made the write path unreachable in the first place.',
  '--',
  '-- Three rules, in order:',
  '--   TECHNICAL  a platform behaviour a system administrator legitimately owns: the integration,',
  '--              retention, event, backup, migration, media, notification, and platform',
  '--              namespaces. No technical key may be SENSITIVE — the generator throws if one is,',
  '--              so a key in a technical namespace that changes money must be classified',
  '--              deliberately rather than swept up by a prefix.',
  '--   SENSITIVE  changes money owed, tax computed, or credit exposure. Routed through the',
  '--              config_change approval, to the HIGHEST level until a per-key level is set.',
  '--   ROUTINE    everything else; takes effect on schedule.',
  '--',
  '-- The owner role is per namespace, taken from the roles Appendix D.1 already registers. A key',
  '-- with no namespace owner is a generator error rather than a silently unowned key.',
  '--',
  '-- Reclassifying one key: change the rule in scripts/generate-config-key-seed.mjs and re-run. Do',
  '-- not edit the rows below, and do not reclassify in the database without recording why.',
  '',
  `${INSERT}`,
  seedRows.join(',\n') + ';',
].join('\n');

const path = fileURLToPath(new URL(`../${MIGRATION}`, import.meta.url));
const text = readFileSync(path, 'utf8');

const blockStart = text.indexOf(SEED_HEADER);
if (blockStart === -1) {
  throw new Error(
    `The generated seed block is missing from ${MIGRATION}. Expected a line starting: ${SEED_HEADER}`,
  );
}

// Everything from the anchor to the end of the file is generated, so a stale or duplicated block is
// replaced wholesale rather than appended to. A repeated anchor is the specific hazard here: earlier
// revisions used a start/end marker pair, and a comment that merely mentioned the marker became a
// boundary, growing a second block on every run.
const anchorCount = text.split(SEED_HEADER).length - 1;
if (anchorCount !== 1) {
  throw new Error(
    `${MIGRATION} contains ${anchorCount} copies of the generated-seed anchor; expected exactly 1. `
    + 'Remove the duplicates, or restore the file from git and re-run.',
  );
}

const handWritten = text.slice(0, blockStart).trimEnd();

/**
 * Rows as committed, trimmed and with the separating comma removed, so the comparison is about the
 * classification rather than the indentation or the join. Compared on both sides identically —
 * `seedRows` carry their own leading indent, so only one side being trimmed reports a difference
 * that does not exist.
 */
// The final row keeps the statement's semicolon but has no separating comma, so normalising the
// comma alone leaves a difference on the last line only. Drop both.
const normalise = (line) => line.trim().replace(/[,;]$/, '');
const committedRows = (source) => source.slice(source.indexOf(SEED_HEADER))
  .split('\n')
  .map(normalise)
  .filter((line) => line.startsWith('('));
const expectedRows = seedRows.map(normalise);

if (process.argv.includes('--check')) {
  const existing = committedRows(text);
  const firstDifference = existing.findIndex((line, index) => line !== expectedRows[index]);
  if (firstDifference !== -1 || existing.length !== expectedRows.length) {
    const at = firstDifference === -1 ? existing.length : firstDifference;
    process.stderr.write(
      `config-key seed is stale: ${MIGRATION} carries ${existing.length} rows, the registry `
      + `classifies ${summary.total}. First difference at row ${at}.\n`
      + `  committed: ${existing[at] ?? '(missing)'}\n`
      + `  expected:  ${expectedRows[at] ?? '(missing)'}\n`
      + 'Run `pnpm config-keys:seed`.\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `PLT-009 config key registry: ${summary.total} keys classified and in sync `
      + `(${summary.technical} technical, ${summary.sensitive} sensitive, ${summary.routine} routine).\n`,
    );
  }
} else {
  writeFileSync(path, `${handWritten}\n\n${SEED_BLOCK}\n`);
  process.stdout.write(
    `Wrote ${summary.total} classified keys to ${MIGRATION} `
    + `(${summary.technical} technical, ${summary.sensitive} sensitive, ${summary.routine} routine).\n`,
  );
}
