import Decimal from 'decimal.js';

/**
 * The quantity format the stock ledger stores.
 *
 * `inventory.stock_movement.qty` is `numeric(18,3)` and `qty_delta` is signed, so the API's
 * validators require exactly three decimals: an operator typing "40" has to reach the domain as
 * "40.000" or the request is refused as VALIDATION_FAILED for a reason they cannot see. Normalising
 * here is a display-to-wire concern, not a rule about how much may be received — that rule belongs to
 * the domain, which is what refuses it.
 *
 * Decimal, never a float: `0.1 + 0.2` must not decide what the warehouse is told it received.
 */
export function threeDecimals(typed: string): string {
  const trimmed = typed.trim();
  if (trimmed === '' || !/^-?\d*[.,]?\d*$/.test(trimmed) || !/\d/.test(trimmed)) return '';
  // A comma is the Indonesian decimal separator; a dot is the wire one. Only one is accepted.
  const normalized = new Decimal(trimmed.replace(',', '.')).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return normalized.toFixed(3);
}

/** A quantity as the operator reads it: "40", not "40.000". */
export function plainQuantity(value: string): string {
  return new Decimal(value).toString();
}
