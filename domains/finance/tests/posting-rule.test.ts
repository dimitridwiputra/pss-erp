import { describe, expect, it } from 'vitest';
import { buildJournalFromEvent, demoPostingRules, validateBalancedLines } from '../src/domain/posting-rule';

const businessDate = '2026-10-01';
function build(eventType: string, payload: Record<string, unknown>) {
  const rule = demoPostingRules.find((entry) => entry.eventType === eventType)!;
  return buildJournalFromEvent(rule.template, { eventType, payload: { businessDate, ...payload } });
}

describe('MVP demo posting matrix', () => {
  it.each([
    ['INVENTORY_RECEIVED', { totalCost: '100.00' }, ['1-1400', '2-1150']],
    ['INVENTORY_ISSUED', { totalCost: '40.00' }, ['5-1000', '1-1400']],
    ['INVENTORY_ADJUSTED', { totalCostDelta: '-20.00' }, ['6-2100', '1-1400']],
    ['INVENTORY_ADJUSTED', { totalCostDelta: '20.00' }, ['1-1400', '6-2100']],
    ['INVOICE_ISSUED', { subtotal: '100.00', taxAmount: '11.00', total: '111.00' }, ['1-1300', '4-1000', '2-1300']],
    ['PAYMENT_RECEIVED', { method: 'TUNAI', amount: '111.00' }, ['1-1110', '1-1300']],
    ['CASH_CUSTODY_VERIFIED', { countedAmount: '110.00', declaredAmount: '111.00', varianceAmount: '-1.00' }, ['1-1100', '1-1110', '6-2200']],
    ['CASH_CUSTODY_VERIFIED', { countedAmount: '112.00', declaredAmount: '111.00', varianceAmount: '1.00' }, ['1-1100', '1-1110', '6-2200']],
  ] as const)('%s produces balanced entries', (eventType, payload, accountCodes) => {
    const result = build(eventType, payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lines.map((line) => line.accountCode)).toEqual(accountCodes);
      expect(validateBalancedLines(result.lines)).toBe(true);
    }
  });

  it('routes null cost to an exception', () => {
    expect(build('INVENTORY_RECEIVED', { totalCost: null })).toEqual({ ok: false, code: 'UNVALUED_INVENTORY' });
    expect(build('INVENTORY_ADJUSTED', { totalCostDelta: null })).toEqual({ ok: false, code: 'UNVALUED_INVENTORY' });
  });

  it('omits PPN when invoice tax is zero', () => {
    const result = build('INVOICE_ISSUED', { subtotal: '100.00', taxAmount: '0.00', total: '100.00' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lines.map((line) => line.accountCode)).toEqual(['1-1300', '4-1000']);
  });

  it('puts shortage on debit and overage on credit', () => {
    const shortage = build('CASH_CUSTODY_VERIFIED', { countedAmount: '90.00', declaredAmount: '100.00', varianceAmount: '-10.00' });
    const overage = build('CASH_CUSTODY_VERIFIED', { countedAmount: '110.00', declaredAmount: '100.00', varianceAmount: '10.00' });
    expect(shortage.ok && shortage.lines[2]).toMatchObject({ debit: '10.00', credit: '0.00' });
    expect(overage.ok && overage.lines[2]).toMatchObject({ debit: '0.00', credit: '10.00' });
  });

  it('rejects mismatched totals and rule/event pairs', () => {
    expect(build('INVOICE_ISSUED', { subtotal: '100.00', taxAmount: '11.00', total: '100.00' })).toEqual({ ok: false, code: 'INVALID_AMOUNT' });
    expect(buildJournalFromEvent({ kind: 'PAYMENT' }, { eventType: 'INVOICE_ISSUED', payload: {} })).toEqual({ ok: false, code: 'RULE_EVENT_MISMATCH' });
  });
});
