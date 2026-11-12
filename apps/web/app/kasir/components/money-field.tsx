'use client';

import { moneyInput } from '../lib/money';

const thousands = new Intl.NumberFormat('id-ID');

/**
 * DESIGN_SYSTEM §8.4 "Format rupiah otomatis": the cashier sees 250.000 while typing; the value
 * held and sent is the plain digit string the API expects.
 */
export function MoneyField({ label, value, onChange, autoFocus = false }: {
  label: string; value: string; onChange: (digits: string) => void; autoFocus?: boolean;
}) {
  return (
    <label className="pos-field">{label}
      <span className="pos-money-input">
        <span aria-hidden="true">Rp</span>
        <input inputMode="numeric" autoComplete="off" autoFocus={autoFocus} placeholder="0"
          value={value === '' ? '' : thousands.format(BigInt(value))}
          onChange={(event) => onChange(moneyInput(event.target.value))} />
      </span>
    </label>
  );
}
