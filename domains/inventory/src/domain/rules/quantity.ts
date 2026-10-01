import Decimal from 'decimal.js';
import { DomainError } from '@pss/contracts';

/**
 * A quantity that moves stock must be greater than zero.
 *
 * `DecimalStringSchema` accepts a signed value because the ledger has genuinely signed rows — an
 * adjustment's `qty` is a surplus or a shortage. A receipt and an issue are not signed: a negative
 * receipt would quietly become an issue that consumes a reservation nobody checked, and a negative
 * issue would be a receipt that takes money out of inventory value. The sign is a business rule, so
 * it is checked here rather than left to a regex that would also have to reject a bare `-0`.
 */
export function requirePositiveQuantity(value: string, path: string, label: string): void {
  if (!new Decimal(value).gt(0)) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path, code: 'not_positive', message: `${label} harus lebih besar dari nol.`,
    }]);
  }
}

/**
 * An adjustment's signed quantity may be a surplus or a shortage, but not zero.
 *
 * A zero adjustment is not a harmless no-op: it writes a movement row, publishes an
 * `INVENTORY_ADJUSTED` event with a zero value, and asks finance to post a journal line for a
 * correction that did not happen. It is almost always an operator who typed nothing into a required
 * field, so it is refused with a message on the field.
 */
export function requireNonZeroQuantity(value: string, path: string, label: string): void {
  if (new Decimal(value).isZero()) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path, code: 'zero', message: `${label} tidak boleh nol. Isi selisih jumlah barangnya.`,
    }]);
  }
}
