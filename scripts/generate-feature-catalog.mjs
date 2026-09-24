import { readFile, mkdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const planPath = new URL('docs/IMPLEMENTATION_PLAN.md', root);
const prdPath = new URL('docs/PRODUCT_PRD.md', root);
const statusPath = new URL('docs/features/status.json', root);
const outputPath = new URL('apps/web/data/features.generated.json', root);

const featureIdPattern = /^[A-Z]+-\d{3}$/;

function field(block, label) {
  const line = block.split('\n').find((value) => value.startsWith(`**${label}:** `));
  if (!line) throw new Error(`Missing ${label} in PRD feature block.`);
  return line.slice(`**${label}:** `.length).trim();
}

function readable(value) {
  return value.replace(/\*\*/g, '').replace(/`/g, '');
}

export function parseFeatureCatalog(planMarkdown, prdMarkdown, implementationStatus) {
  const appendix = planMarkdown.split('## Lampiran A — Penjadwalan Fitur (280 fitur)')[1]?.split('## Lampiran B')[0];
  if (!appendix) throw new Error('Implementation plan Appendix A is missing.');

  const prdFeatures = new Map();
  for (const block of prdMarkdown.split(/(?=^#### [A-Z]+-\d{3} — )/m)) {
    if (!/^#### [A-Z]+-\d{3} — /.test(block)) continue;
    const id = field(block, 'FEATURE ID');
    if (prdFeatures.has(id)) throw new Error(`Duplicate PRD feature ${id}.`);
    prdFeatures.set(id, {
      user: readable(field(block, 'PRIMARY USER')),
      outcome: readable(field(block, 'USER OUTCOME')),
    });
  }

  const features = appendix.split('\n').filter((line) => /^\| [A-Z]+-\d{3} \|/.test(line))
    .map((line) => {
      const columns = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (columns.length !== 8) throw new Error(`Malformed implementation plan row: ${line}`);
      const [id, name, phase, priority, , pod, sprint, dependencies] = columns;
      if (!id || !featureIdPattern.test(id) || !name || !phase || !priority || !pod || !sprint || !dependencies) {
        throw new Error(`Incomplete implementation plan row: ${line}`);
      }
      const prd = prdFeatures.get(id);
      if (!prd) throw new Error(`Plan feature ${id} has no PRD specification.`);
      const implementation = implementationStatus[id] ?? { state: 'planned' };
      if (!['available', 'partial', 'planned'].includes(implementation.state)) throw new Error(`Invalid state for ${id}.`);
      if (implementation.availablePath && implementation.state !== 'available') throw new Error(`Unfinished ${id} cannot link to a working screen.`);
      return {
        id,
        name: readable(name),
        phase,
        priority,
        pod,
        sprint,
        dependencies: dependencies === '—' ? [] : dependencies.split(',').map((part) => part.trim()),
        user: prd.user,
        outcome: prd.outcome,
        state: implementation.state,
        ...(implementation.availablePath ? { availablePath: implementation.availablePath } : {}),
        ...(implementation.note ? { note: implementation.note } : {}),
      };
    });

  const ids = features.map((feature) => feature.id);
  if (features.length !== 280 || new Set(ids).size !== 280 || prdFeatures.size !== 280) {
    throw new Error(`Expected 280 unique features in plan and PRD; found plan=${features.length}, PRD=${prdFeatures.size}.`);
  }
  for (const id of Object.keys(implementationStatus)) {
    if (!ids.includes(id)) throw new Error(`Implementation status references unknown feature ${id}.`);
  }
  return features;
}

if (process.argv[1]?.endsWith('/generate-feature-catalog.mjs')) {
  const [plan, prd, statusText] = await Promise.all([
    readFile(planPath, 'utf8'), readFile(prdPath, 'utf8'), readFile(statusPath, 'utf8'),
  ]);
  const rendered = `${JSON.stringify(parseFeatureCatalog(plan, prd, JSON.parse(statusText)), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== rendered) throw new Error('Feature directory is stale. Run node scripts/generate-feature-catalog.mjs.');
    process.stdout.write('Feature directory matches 280 PRD and implementation plan features.\n');
  } else {
    await mkdir(new URL('.', outputPath), { recursive: true });
    await writeFile(outputPath, rendered);
    process.stdout.write('Generated 280 source-backed feature directory entries.\n');
  }
}
