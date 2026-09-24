import { describe, expect, it } from 'vitest';
import { checkSourceQuality } from '../scripts/check-code-quality.mjs';

const path = 'domains/orders/domain/rules/example.ts';

describe('PLT-002 source lint', () => {
  it('rejects a hard-coded principal or branch comparison', () => {
    expect(checkSourceQuality({ path, source: "if (principal === 'NESTLE') {}" }))
      .toEqual([expect.stringContaining('hard-coded principal/branch')]);
    expect(checkSourceQuality({ path, source: "if ('JAKARTA' === branchCode) {}" }))
      .toEqual([expect.stringContaining('hard-coded principal/branch')]);
  });

  it('rejects console.log and unreferenced TODO comments', () => {
    const issues = checkSourceQuality({ path, source: '// TODO: fix later\nconsole.log("hello");' });
    expect(issues).toHaveLength(2);
    expect(issues.join(' ')).toContain('structured logger');
    expect(issues.join(' ')).toContain('TODO needs');
  });

  it('accepts an open-decision reference and non-business comparison', () => {
    expect(checkSourceQuality({ path, source: "// TODO OD-120: confirm IdP\nif (status === 'ACTIVE') {}" })).toEqual([]);
  });
});
