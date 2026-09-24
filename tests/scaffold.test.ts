import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertToolchain } from '../scripts/check-toolchain.mjs';
import { createDomain } from '../scripts/domain-template.mjs';
import { findDependencyProblems } from '../scripts/check-workspace.mjs';
import { scanFiles } from '../scripts/check-secrets.mjs';

describe('PLT-001 toolchain and workspace', () => {
  it('PLT-001.AC01 rejects the wrong Node or pnpm version with a clear message', () => {
    expect(() => assertToolchain('v24.19.0', 'pnpm/11.19.0 npm/? node/v24.19.0')).not.toThrow();
    expect(() => assertToolchain('v22.0.0', 'pnpm/11.19.0 npm/?')).toThrow(/Node.js 24.19.0/);
    expect(() => assertToolchain('v24.19.0', 'npm/10.0.0')).toThrow(/pnpm 11.19.0/);
  });

  it('PLT-001.AC03 generates the standard domain structure and prevents overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pss-domain-'));
    try {
      const directory = await createDomain(root, 'example-domain');
      const domainDoc = await readFile(join(directory, 'DOMAIN.md'), 'utf8');
      const migrationKeep = await readFile(join(directory, 'infrastructure/database/migrations/.gitkeep'), 'utf8');
      expect(domainDoc).toContain('## Events produced and consumed');
      expect(migrationKeep).toBe('');
      await expect(createDomain(root, 'example-domain')).rejects.toThrow(/already exists/);
      await expect(createDomain(root, '../outside')).rejects.toThrow(/kebab-case/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('PLT-001.AC05 rejects conflicting versions and another validation library', () => {
    const problems = findDependencyProblems([
      ['one', { dependencies: { zod: '4.0.0', react: '19.3.0' } }],
      ['two', { dependencies: { react: '18.3.1', yup: '1.0.0' } }],
    ]);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('react:'), expect.stringContaining('yup duplicates')]));
  });

  it('PLT-001.NC02 identifies environment files and common private key material', async () => {
    const problems = await scanFiles(['.env', 'code.ts'], async () => ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
    expect(problems).toHaveLength(2);
  });
});
