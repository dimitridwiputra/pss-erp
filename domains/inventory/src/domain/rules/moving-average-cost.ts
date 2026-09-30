import Decimal from 'decimal.js';

/**
 * INV-003 / MVP-OD-4 — moving-average costing.
 *
 * Pure arithmetic, no I/O and no clock, so the rule can be read on its own and the tests say
 * exactly what it does with a NULL. The three values it never invents are the whole point of the
 * design, so they are named rather than collapsed into a zero:
 *
 *   - `movementUnitCost === null`  the movement is UNVALUED. Nobody said what this stock cost, so
 *                                  no number is written and the event carries `unitCost: null`,
 *                                  which finance routes to its exception queue (MVP_PLAN §5).
 *   - `balanceAvgUnitCost === null` the balance has never been valued.
 *   - a valued receipt into a balance that still holds unvalued quantity leaves BOTH null. Deciding
 *     what the unvalued quantity was worth is a revaluation, it is not in the MVP, and guessing
 *     would post a made-up amount to the GL. MVP-OD-15 in MVP_PLAN §10 carries the decision; until
 *     it is taken the conservative answer is a visible unvalued movement, not a silent zero.
 *
 * Precision: `inventory.stock_balance.avg_unit_cost` and `stock_movement.unit_cost` are
 * `numeric(18,4)` and `total_cost` is `numeric(18,2)`, so the rule rounds to 4 places for a unit
 * cost and 2 for a total, half away from zero. The PRD's `inventory.cost_precision` default of 6
 * for unit cost is MVP-OD-12; 4 is used because it is the scale the columns and the event payload
 * carry.
 */
export const UNIT_COST_SCALE = 4;
export const TOTAL_COST_SCALE = 2;

export type CostingMovementKind = 'RECEIVE' | 'ISSUE' | 'ADJUSTMENT';

export interface MovingAverageInput {
  /** On-hand quantity of the balance before the movement, as a decimal string. */
  balanceQtyOnHand: Decimal.Value;
  /** The balance's stored average, or `null` when the balance has never been valued. */
  balanceAvgUnitCost: Decimal.Value | null;
  kind: CostingMovementKind;
  /** RECEIVE/ISSUE: the quantity moved, positive. ADJUSTMENT: the signed delta (surplus +, shortage −). */
  qty: Decimal.Value;
  /** RECEIVE only: the cost of the incoming stock, or `null` for a receipt that arrives without one. */
  receivedUnitCost?: Decimal.Value | null;
}

export interface MovingAverageResult {
  /** `numeric(18,4)`, or `null` when this movement is unvalued. */
  movementUnitCost: string | null;
  /**
   * `numeric(18,2)`. Signed for ADJUSTMENT (a shortage is a negative cost), never negative for a
   * RECEIVE or an ISSUE. `null` when the movement is unvalued.
   */
  movementTotalCost: string | null;
  /** The balance's average after the movement, or `null` when the balance stays unvalued. */
  balanceAvgUnitCost: string | null;
}

function toDecimal(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

/** Fixed-scale output with no exponent and no negative zero; `-0.004` at 2 places is `0.00`. */
function fixed(value: Decimal, scale: number): string {
  const rounded = value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  // `plus(0)` drops a negative zero that toDecimalPlaces can leave behind, which the published
  // money formats reject (`SignedMoneyV1` in packages/contracts/src/events/index.ts).
  return rounded.plus(0).toFixed(scale);
}

/**
 * The single place a stock movement's valuation is decided. Callers read the balance row under
 * `FOR UPDATE`, call this, and write back `balanceAvgUnitCost` with the quantity update in the same
 * statement, so a concurrent movement cannot be averaged into a stale balance.
 *
 * A total is always multiplied out at full precision and only then rounded, never recomputed from
 * the rounded unit cost. The two stored columns may therefore differ by a fraction of a seny — that
 * residual is INV-003's rounding-difference case (its exception flow E1) and it is the reason the
 * total, not the unit cost, is what finance posts (MVP_PLAN §8).
 */
export function applyMovingAverage(input: MovingAverageInput): MovingAverageResult {
  const qtyOnHand = toDecimal(input.balanceQtyOnHand);
  const qty = toDecimal(input.qty);
  const average = input.balanceAvgUnitCost === null ? null : toDecimal(input.balanceAvgUnitCost);

  if (input.kind === 'RECEIVE') {
    if (input.receivedUnitCost === null || input.receivedUnitCost === undefined) {
      return unvalued(average);
    }
    const receivedUnitCost = toDecimal(input.receivedUnitCost);
    if (average === null && !qtyOnHand.isZero()) {
      // Quantity is on hand that was never valued. Valuing it now is a revaluation decision
      // (MVP-OD-15), so the receipt itself is recorded unvalued and the balance stays unvalued.
      return unvalued(null);
    }
    const qtyAfter = qtyOnHand.plus(qty);
    if (qtyAfter.isZero()) {
      // Only reachable with a zero-quantity receipt, which the command input rejects. Refusing to
      // guess an average for a division by zero is cheaper than a NaN reaching the ledger.
      return unvalued(null);
    }
    const valueOnHand = average === null ? new Decimal(0) : qtyOnHand.times(average);
    const nextAverage = valueOnHand.plus(qty.times(receivedUnitCost)).dividedBy(qtyAfter);
    return {
      movementUnitCost: fixed(receivedUnitCost, UNIT_COST_SCALE),
      movementTotalCost: fixed(qty.times(receivedUnitCost), TOTAL_COST_SCALE),
      balanceAvgUnitCost: fixed(nextAverage, UNIT_COST_SCALE),
    };
  }

  // An ISSUE and an ADJUSTMENT both leave the average where it is: moving average re-averages on
  // quantity coming IN. Neither can value a movement from a balance that has no average.
  if (average === null) return unvalued(null);
  const unitCost = fixed(average, UNIT_COST_SCALE);
  return {
    movementUnitCost: unitCost,
    movementTotalCost: fixed(qty.times(average), TOTAL_COST_SCALE),
    balanceAvgUnitCost: unitCost,
  };
}

function unvalued(average: Decimal | null): MovingAverageResult {
  return {
    movementUnitCost: null,
    movementTotalCost: null,
    balanceAvgUnitCost: average === null ? null : fixed(average, UNIT_COST_SCALE),
  };
}
