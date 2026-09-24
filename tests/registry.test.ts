import { describe, expect, it } from 'vitest';
import { findConfigurationSeed, findErrorCode, findQueueSeed, findStatusCopy, registryCatalog } from '../packages/contracts/src/registry';
import { parseRegistryCatalog } from '../scripts/generate-registry-catalog.mjs';
import { readFile } from 'node:fs/promises';

describe('PLT-003 source-preserving registries', () => {
  it('loads the core PRD registries as queryable data', () => {
    expect(registryCatalog.version).toBe(1);
    expect(registryCatalog.baseErrors).toHaveLength(11);
    expect(registryCatalog.offlineStatuses.map((entry) => entry.code)).toEqual(['SAVED', 'PENDING_SYNC', 'NEEDS_REVIEW']);
    expect(findErrorCode('PERMISSION_DENIED')?.httpCategory).toContain('403');
    expect(findQueueSeed('Q-CREDIT_HOLD')?.ownerRole).toContain('BRANCH_MANAGER');
    expect(findStatusCopy('Journal · POSTED')?.desktopLabel).toBe('Diposting');
  });

  it('preserves unapproved configuration wording without turning it into a runtime default', () => {
    expect(findConfigurationSeed('invoicing.recognition_point')?.defaultText).toContain('ASM');
    expect(findConfigurationSeed('approval.<type>.levels')?.defaultText).toContain('KOSONG');
    expect(registryCatalog.reasonCodes.some((entry) => entry.placeholder)).toBe(true);
  });

  it('rejects a missing registry section', async () => {
    const markdown = await readFile(new URL('../docs/PRODUCT_PRD.md', import.meta.url), 'utf8');
    expect(() => parseRegistryCatalog(markdown.replace('### F.1 Kode dasar', '### F.1 Removed'))).toThrow(/Registry section/);
  });
});
