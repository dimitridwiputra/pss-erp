import { describe, expect, it } from 'vitest';
import { applyMovingAverage, UNIT_COST_SCALE, TOTAL_COST_SCALE } from '@pss/inventory';

// INV-003 / MVP-OD-4. A pure rule, so the interesting cases need no database: what it does when the
// balance has never been valued, and what scale each number comes out at. The NULL cases are the
// ones that must not quietly become a zero (AGENTS.md §3.7).
describe('moving-average costing (INV-003)', () => {
  describe('receipt with a cost', () => {
    it('re-averages quantity and value together (INV-003.AC01)', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '10', balanceAvgUnitCost: '100', kind: 'RECEIVE', qty: '10', receivedUnitCost: '120',
      });
      expect(result.balanceAvgUnitCost).toBe('110.0000');
      expect(result.movementUnitCost).toBe('120.0000');
      expect(result.movementTotalCost).toBe('1200.00');
    });

    it('averages a first receipt onto a balance that holds no quantity', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '0', balanceAvgUnitCost: null, kind: 'RECEIVE', qty: '24', receivedUnitCost: '9750.5',
      });
      expect(result.balanceAvgUnitCost).toBe('9750.5000');
      expect(result.movementTotalCost).toBe('234012.00');
    });

    it('takes the receipt cost when the balance is empty but still carries an old average', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '0', balanceAvgUnitCost: '100', kind: 'RECEIVE', qty: '5', receivedUnitCost: '250',
      });
      expect(result.balanceAvgUnitCost).toBe('250.0000');
    });

    it('weights the average, it does not average the two numbers', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '300', balanceAvgUnitCost: '1000', kind: 'RECEIVE', qty: '100', receivedUnitCost: '1600',
      });
      expect(result.balanceAvgUnitCost).toBe('1150.0000');
    });
  });

  describe('receipt without a cost', () => {
    it('leaves the average alone and records the movement unvalued', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '10', balanceAvgUnitCost: '100', kind: 'RECEIVE', qty: '5', receivedUnitCost: null,
      });
      expect(result).toEqual({ movementUnitCost: null, movementTotalCost: null, balanceAvgUnitCost: '100.0000' });
    });

    it('treats a receipt that carries no cost field the same as one carrying null', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '10', balanceAvgUnitCost: '100', kind: 'RECEIVE', qty: '5',
      });
      expect(result.movementUnitCost).toBeNull();
      expect(result.movementTotalCost).toBeNull();
    });

    it('keeps the balance unvalued when it was never valued', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '7', balanceAvgUnitCost: null, kind: 'RECEIVE', qty: '3', receivedUnitCost: null,
      });
      expect(result.balanceAvgUnitCost).toBeNull();
    });

    it('refuses to value the receipt when unvalued quantity is already on hand (MVP-OD-15)', () => {
      // Valuing that quantity is a revaluation, which the MVP does not have. Inventing a value here
      // would post a made-up amount to the GL, so both stay unvalued and finance sees the exception.
      const result = applyMovingAverage({
        balanceQtyOnHand: '100', balanceAvgUnitCost: null, kind: 'RECEIVE', qty: '50', receivedUnitCost: '10000',
      });
      expect(result).toEqual({ movementUnitCost: null, movementTotalCost: null, balanceAvgUnitCost: null });
    });
  });

  describe('issue', () => {
    it('values the issue at the current average and does not re-average', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '100', balanceAvgUnitCost: '110', kind: 'ISSUE', qty: '5',
      });
      expect(result.movementUnitCost).toBe('110.0000');
      expect(result.movementTotalCost).toBe('550.00');
      expect(result.balanceAvgUnitCost).toBe('110.0000');
    });

    it('is unvalued when the balance was never valued', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '100', balanceAvgUnitCost: null, kind: 'ISSUE', qty: '5',
      });
      expect(result).toEqual({ movementUnitCost: null, movementTotalCost: null, balanceAvgUnitCost: null });
    });

    it('uses the average in effect before the issue, not one the issue itself creates', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '10', balanceAvgUnitCost: '1234.5678', kind: 'ISSUE', qty: '10',
      });
      expect(result.movementUnitCost).toBe('1234.5678');
      expect(result.balanceAvgUnitCost).toBe('1234.5678');
    });
  });

  describe('adjustment', () => {
    it('values a shortage as a negative cost at the current average', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '40', balanceAvgUnitCost: '2500', kind: 'ADJUSTMENT', qty: '-3',
      });
      expect(result.movementUnitCost).toBe('2500.0000');
      expect(result.movementTotalCost).toBe('-7500.00');
    });

    it('values a surplus as a positive cost at the current average', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '40', balanceAvgUnitCost: '2500', kind: 'ADJUSTMENT', qty: '3',
      });
      expect(result.movementTotalCost).toBe('7500.00');
    });

    it('is unvalued when the balance was never valued, and does not invent an average', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '40', balanceAvgUnitCost: null, kind: 'ADJUSTMENT', qty: '-3',
      });
      expect(result).toEqual({ movementUnitCost: null, movementTotalCost: null, balanceAvgUnitCost: null });
    });
  });

  describe('rounding', () => {
    it('keeps 4 places on a unit cost and 2 on a total', () => {
      expect(UNIT_COST_SCALE).toBe(4);
      expect(TOTAL_COST_SCALE).toBe(2);
      const result = applyMovingAverage({
        balanceQtyOnHand: '0', balanceAvgUnitCost: null, kind: 'RECEIVE', qty: '7', receivedUnitCost: '1234.56785',
      });
      expect(result.movementUnitCost).toBe('1234.5679');
      // The total comes from the full-precision average, not from the rounded 4-place unit cost:
      // 7 × 1234.5679 would be 8641.98, so the two stored columns can differ by a seny. The total is
      // the number finance posts, and the residual is INV-003's rounding-difference case (E1).
      expect(result.movementTotalCost).toBe('8641.97');
    });

    it('rounds a unit cost half away from zero at 4 places', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '0', balanceAvgUnitCost: null, kind: 'RECEIVE', qty: '1', receivedUnitCost: '0.00005',
      });
      expect(result.balanceAvgUnitCost).toBe('0.0001');
    });

    it('never emits a negative zero, which the published money format rejects', () => {
      // -0.004 at 2 places is zero, and `-0.00` is not a money value to SignedMoneyV1.
      const result = applyMovingAverage({
        balanceQtyOnHand: '10', balanceAvgUnitCost: '100', kind: 'ADJUSTMENT', qty: '-0.00004',
      });
      expect(result.movementTotalCost).toBe('0.00');
    });

    it('emits fixed-scale strings, never an exponent or a shorter number', () => {
      const result = applyMovingAverage({
        balanceQtyOnHand: '0', balanceAvgUnitCost: null, kind: 'RECEIVE', qty: '1', receivedUnitCost: '0.5',
      });
      expect(result.movementUnitCost).toBe('0.5000');
      expect(result.movementTotalCost).toBe('0.50');
    });
  });
});
