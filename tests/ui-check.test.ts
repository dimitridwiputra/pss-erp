import { describe, expect, it } from 'vitest';
import { checkUiSource } from '../scripts/check-ui.mjs';

describe('UX-001 UI lint', () => {
  it('rejects arbitrary hex outside the token source', () => {
    expect(checkUiSource({ path: 'apps/web/app/test.css', source: '.card { color: #123456; }' }))
      .toEqual([expect.stringContaining('raw hex')]);
    expect(checkUiSource({ path: 'packages/ui/tokens.css', source: ':root { --color: #123456; }' })).toEqual([]);
  });

  it('PLT-002.AC06 rejects raw enum text and direct state rendering', () => {
    const issues = checkUiSource({ path: 'apps/web/app/page.tsx', source: '<div><span>PENDING_APPROVAL</span><span>{order.status}</span></div>' });
    expect(issues).toEqual([
      expect.stringContaining('raw enum'),
      expect.stringContaining('registered UI label'),
    ]);
  });

  it('rejects generic English button labels', () => {
    expect(checkUiSource({ path: 'apps/web/app/page.tsx', source: 'export const view = <button>Submit</button>;' }))
      .toEqual([expect.stringContaining('not actionable Indonesian copy')]);
    expect(checkUiSource({ path: 'apps/web/app/page.tsx', source: 'export const view = <button>Simpan</button>;' })).toEqual([]);
    expect(checkUiSource({ path: 'apps/web/app/page.tsx', source: 'export const view = <Button label="Submit" />;' }))
      .toEqual([expect.stringContaining('not actionable Indonesian copy')]);
  });
});
