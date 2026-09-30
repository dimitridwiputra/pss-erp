import Decimal from 'decimal.js';
import { z } from 'zod';

const money = z.string().regex(/^-?\d+\.\d{2}$/);
const base = z.object({ businessDate: z.iso.date() });
const receipt = base.extend({ totalCost: money.nullable() });
const adjustment = base.extend({ totalCostDelta: money.nullable() });
const invoice = base.extend({ subtotal: money, taxAmount: money, total: money });
const payment = base.extend({ method: z.literal('TUNAI'), amount: money });
const custody = base.extend({ countedAmount: money, declaredAmount: money, varianceAmount: money });

export const PostingTemplateSchema = z.strictObject({
  kind: z.enum(['RECEIPT','ISSUE','ADJUSTMENT','INVOICE','PAYMENT','CUSTODY']),
});
export type PostingTemplate = z.infer<typeof PostingTemplateSchema>;
export type PostingEvent = { eventType: string; payload: unknown };
export type JournalLine = { accountCode: string; debit: string; credit: string; memo: string };
export type BuildFailure = { ok: false; code: 'INVALID_PAYLOAD' | 'UNVALUED_INVENTORY' | 'INVALID_AMOUNT' | 'UNBALANCED_JOURNAL' | 'RULE_EVENT_MISMATCH' };
export type BuildResult = { ok: true; lines: JournalLine[] } | BuildFailure;

export const demoPostingRules: ReadonlyArray<{ eventType: string; version: 1; template: PostingTemplate }> = [
  { eventType: 'INVENTORY_RECEIVED', version: 1, template: { kind: 'RECEIPT' } },
  { eventType: 'INVENTORY_ISSUED', version: 1, template: { kind: 'ISSUE' } },
  { eventType: 'INVENTORY_ADJUSTED', version: 1, template: { kind: 'ADJUSTMENT' } },
  { eventType: 'INVOICE_ISSUED', version: 1, template: { kind: 'INVOICE' } },
  { eventType: 'PAYMENT_RECEIVED', version: 1, template: { kind: 'PAYMENT' } },
  { eventType: 'CASH_CUSTODY_VERIFIED', version: 1, template: { kind: 'CUSTODY' } },
];

const eventForKind: Record<PostingTemplate['kind'], string> = {
  RECEIPT: 'INVENTORY_RECEIVED', ISSUE: 'INVENTORY_ISSUED', ADJUSTMENT: 'INVENTORY_ADJUSTED',
  INVOICE: 'INVOICE_ISSUED', PAYMENT: 'PAYMENT_RECEIVED', CUSTODY: 'CASH_CUSTODY_VERIFIED',
};

function line(accountCode: string, side: 'DEBIT' | 'CREDIT', amount: Decimal): JournalLine {
  return { accountCode, debit: side === 'DEBIT' ? amount.toFixed(2) : '0.00',
    credit: side === 'CREDIT' ? amount.toFixed(2) : '0.00', memo: '' };
}

export function validateBalancedLines(lines: readonly JournalLine[]): boolean {
  if (lines.length < 2) return false;
  if (lines.some((entry) => {
    const debit = new Decimal(entry.debit), credit = new Decimal(entry.credit);
    return !((debit.isPositive() && credit.isZero()) || (credit.isPositive() && debit.isZero()));
  })) return false;
  const debit = lines.reduce((sum, entry) => sum.plus(entry.debit), new Decimal(0));
  const credit = lines.reduce((sum, entry) => sum.plus(entry.credit), new Decimal(0));
  return debit.equals(credit) && debit.greaterThan(0);
}

/** The template selects a fixed, reviewed rule. No JSON expression is evaluated. */
export function buildJournalFromEvent(rawRule: unknown, event: PostingEvent): BuildResult {
  const parsedRule = PostingTemplateSchema.safeParse(rawRule);
  if (!parsedRule.success) return { ok: false, code: 'INVALID_PAYLOAD' };
  const kind = parsedRule.data.kind;
  if (eventForKind[kind] !== event.eventType) return { ok: false, code: 'RULE_EVENT_MISMATCH' };
  let lines: JournalLine[];
  if (kind === 'RECEIPT' || kind === 'ISSUE') {
    const parsed = receipt.safeParse(event.payload);
    if (!parsed.success) return { ok: false, code: 'INVALID_PAYLOAD' };
    if (parsed.data.totalCost === null) return { ok: false, code: 'UNVALUED_INVENTORY' };
    const amount = new Decimal(parsed.data.totalCost);
    if (!amount.greaterThan(0)) return { ok: false, code: 'INVALID_AMOUNT' };
    lines = kind === 'RECEIPT'
      ? [line('1-1400','DEBIT',amount), line('2-1150','CREDIT',amount)]
      : [line('5-1000','DEBIT',amount), line('1-1400','CREDIT',amount)];
  } else if (kind === 'ADJUSTMENT') {
    const parsed = adjustment.safeParse(event.payload);
    if (!parsed.success) return { ok: false, code: 'INVALID_PAYLOAD' };
    if (parsed.data.totalCostDelta === null) return { ok: false, code: 'UNVALUED_INVENTORY' };
    const amount = new Decimal(parsed.data.totalCostDelta);
    if (amount.isZero()) return { ok: false, code: 'INVALID_AMOUNT' };
    lines = amount.isNegative()
      ? [line('6-2100','DEBIT',amount.abs()), line('1-1400','CREDIT',amount.abs())]
      : [line('1-1400','DEBIT',amount), line('6-2100','CREDIT',amount)];
  } else if (kind === 'INVOICE') {
    const parsed = invoice.safeParse(event.payload);
    if (!parsed.success) return { ok: false, code: 'INVALID_PAYLOAD' };
    const { subtotal, taxAmount, total } = parsed.data;
    const sub = new Decimal(subtotal), tax = new Decimal(taxAmount), gross = new Decimal(total);
    if (!sub.greaterThan(0) || tax.isNegative() || !gross.equals(sub.plus(tax))) return { ok: false, code: 'INVALID_AMOUNT' };
    lines = [line('1-1300','DEBIT',gross), line('4-1000','CREDIT',sub)];
    if (tax.greaterThan(0)) lines.push(line('2-1300','CREDIT',tax));
  } else if (kind === 'PAYMENT') {
    const parsed = payment.safeParse(event.payload);
    if (!parsed.success) return { ok: false, code: 'INVALID_PAYLOAD' };
    const amount = new Decimal(parsed.data.amount);
    if (!amount.greaterThan(0)) return { ok: false, code: 'INVALID_AMOUNT' };
    lines = [line('1-1110','DEBIT',amount), line('1-1300','CREDIT',amount)];
  } else {
    const parsed = custody.safeParse(event.payload);
    if (!parsed.success) return { ok: false, code: 'INVALID_PAYLOAD' };
    const counted = new Decimal(parsed.data.countedAmount);
    const declared = new Decimal(parsed.data.declaredAmount);
    const variance = new Decimal(parsed.data.varianceAmount);
    if (counted.isNegative() || declared.isNegative() || !variance.equals(counted.minus(declared)) ||
      (declared.isZero() && counted.isZero())) {
      return { ok: false, code: 'INVALID_AMOUNT' };
    }
    lines = [line('1-1100','DEBIT',counted), line('1-1110','CREDIT',declared)];
    if (variance.isNegative()) lines.push(line('6-2200','DEBIT',variance.abs()));
    if (variance.isPositive()) lines.push(line('6-2200','CREDIT',variance));
    lines = lines.filter((entry) => entry.debit !== '0.00' || entry.credit !== '0.00');
  }
  return validateBalancedLines(lines) ? { ok: true, lines } : { ok: false, code: 'UNBALANCED_JOURNAL' };
}
