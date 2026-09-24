import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = new URL('../docs/PRODUCT_PRD.md', import.meta.url);
const outputPath = new URL('../packages/contracts/src/events/catalog.generated.ts', import.meta.url);
const eventNamePattern = /`([A-Z][A-Z0-9_]+)`/g;

export function parseEventCatalog(markdown) {
  const appendix = markdown.split('## Appendix C — Event Catalog')[1]?.split('## Appendix D')[0];
  if (!appendix) throw new Error('PRD Appendix C event catalog not found.');
  const catalog = [];
  let section = '';
  let baseCount = 0;
  let additionCount = 0;
  for (const line of appendix.split('\n')) {
    const sectionMatch = /^### C\.(\d+)/.exec(line);
    if (sectionMatch) section = `C.${sectionMatch[1]}`;
    if (!line.startsWith('|') || !/^C\.[1-8]$/.test(section)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (section === 'C.8') {
      if (cells[0] !== 'Event') continue;
      const names = [...(cells[1] ?? '').matchAll(eventNamePattern)].map((match) => match[1]);
      for (const name of names) {
        catalog.push({ name, section, producer: null, aggregate: null, payloadKeys: null });
        additionCount += 1;
      }
      continue;
    }
    const names = [...(cells[0] ?? '').matchAll(eventNamePattern)].map((match) => match[1]);
    for (const name of names) {
      catalog.push({ name, section, producer: cells[1], aggregate: cells[2], payloadKeys: cells[4] });
      baseCount += 1;
    }
  }
  if (baseCount !== 125 || additionCount !== 39 || new Set(catalog.map((item) => item.name)).size !== 164) {
    throw new Error(`Unexpected PRD event catalog: ${baseCount} base, ${additionCount} additions, ${catalog.length} total. Review Appendix C before regenerating.`);
  }
  return catalog;
}

export function renderCatalog(catalog) {
  return `// Generated from docs/PRODUCT_PRD.md Appendix C. Run node scripts/generate-event-catalog.mjs.\nexport const eventCatalog = ${JSON.stringify(catalog, null, 2)} as const;\n`;
}

if (process.argv[1]?.endsWith('/generate-event-catalog.mjs')) {
  const markdown = await readFile(sourcePath, 'utf8');
  const content = renderCatalog(parseEventCatalog(markdown));
  if (process.argv.includes('--check')) {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== content) {
      process.stderr.write('Event catalog is out of sync with PRD Appendix C. Run node scripts/generate-event-catalog.mjs.\n');
      process.exitCode = 1;
    } else process.stdout.write('Event catalog matches PRD Appendix C.\n');
  } else {
    await writeFile(outputPath, content);
    process.stdout.write('Generated 164 catalog event names from PRD Appendix C.\n');
  }
}
