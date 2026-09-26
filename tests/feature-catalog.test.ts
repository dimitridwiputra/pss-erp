import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseFeatureCatalog } from '../scripts/generate-feature-catalog.mjs';

const root = new URL('../', import.meta.url);

describe('source-backed feature directory', () => {
  it('includes every scheduled PRD feature once with a verified status', async () => {
    const [plan, prd, statusText, generatedText] = await Promise.all([
      readFile(new URL('docs/IMPLEMENTATION_PLAN.md', root), 'utf8'),
      readFile(new URL('docs/PRODUCT_PRD.md', root), 'utf8'),
      readFile(new URL('docs/features/status.json', root), 'utf8'),
      readFile(new URL('apps/web/data/features.generated.json', root), 'utf8'),
    ]);
    const parsed = parseFeatureCatalog(plan, prd, JSON.parse(statusText));
    expect(parsed).toHaveLength(280);
    expect(parsed).toEqual(JSON.parse(generatedText));
    expect(parsed.filter((feature) => feature.state === 'available').map((feature) => feature.id)).toEqual(['PLT-001']);
    const declaredPartial = Object.entries(JSON.parse(statusText) as Record<string, { state: string }>)
      .filter(([, status]) => status.state === 'partial').map(([id]) => id).sort();
    expect(parsed.filter((feature) => feature.state === 'partial').map((feature) => feature.id).sort()).toEqual(declaredPartial);
    expect(parsed.find((feature) => feature.id === 'AUD-001')).toMatchObject({ phase: 'F0', state: 'partial' });
    expect(parsed.find((feature) => feature.id === 'OBS-001')).toMatchObject({ phase: 'F0', state: 'partial' });
    expect(parsed.find((feature) => feature.id === 'MDM-001')).toMatchObject({ phase: 'F1', state: 'planned' });
    expect(parsed.find((feature) => feature.id === 'PLT-001')?.availablePath).toBe('/');
  });

  it('rejects status entries with an unknown feature ID', async () => {
    const [plan, prd] = await Promise.all([
      readFile(new URL('docs/IMPLEMENTATION_PLAN.md', root), 'utf8'),
      readFile(new URL('docs/PRODUCT_PRD.md', root), 'utf8'),
    ]);
    expect(() => parseFeatureCatalog(plan, prd, { 'MADE-UP-999': { state: 'available' } }))
      .toThrow(/unknown feature/);
  });
});
