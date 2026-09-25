import { describe, expect, it } from 'vitest';
import { formatJakartaDate, formatRupiah } from '../packages/ui/src/formatters';

describe('UX-001 Indonesian display formatters', () => {
  it('formats whole rupiah without converting precise bigint values to floating point', () => {
    expect(formatRupiah(12_345n)).toMatch(/12\.345/);
    expect(formatRupiah(9_007_199_254_740_993n)).toContain('9.007.199.254.740.993');
  });

  it('uses Jakarta business time when formatting a UTC instant', () => {
    expect(formatJakartaDate(new Date('2026-09-24T18:00:00.000Z'))).toContain('25 Sep 2026');
  });
});
