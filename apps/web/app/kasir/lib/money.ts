import { formatRupiah } from '@pss/ui';
import Decimal from 'decimal.js';

/**
 * Display only. Amounts arrive as decimal strings and are never turned into a JS float: the
 * whole-rupiah part is formatted as a bigint, and any cents are appended as they are.
 */
export function rupiah(value: string): string {
  const amount = new Decimal(value);
  const absolute = amount.abs();
  const cents = absolute.minus(absolute.trunc());
  const whole = formatRupiah(BigInt(absolute.trunc().toFixed(0)));
  return `${amount.isNegative() ? '-' : ''}${whole}${cents.isZero() ? '' : `,${cents.times(100).toFixed(0).padStart(2, '0')}`}`;
}

/** Digits typed into a money field, as the API's decimal string ("" when empty). */
export function moneyInput(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
}

export function isAtLeast(value: string, minimum: string): boolean {
  return value !== '' && new Decimal(value).greaterThanOrEqualTo(minimum);
}

export function difference(left: string, right: string): string {
  return new Decimal(left || '0').minus(right || '0').toFixed(2);
}

export function sum(...values: string[]): string {
  return values.reduce((total, value) => total.plus(value || '0'), new Decimal(0)).toFixed(2);
}

/** Cash-received shortcuts: the exact total, then the next Rp50.000 and Rp100.000 above it. */
export function cashPresets(total: string): string[] {
  const exact = new Decimal(total).ceil();
  const presets = [exact, exact.div(50_000).ceil().times(50_000), exact.div(100_000).ceil().times(100_000)];
  return [...new Set(presets.map((value) => value.toFixed(0)))];
}

/** Human quantity: "2" rather than "2.000". */
export function quantity(value: string): string {
  return new Decimal(value).toString();
}
