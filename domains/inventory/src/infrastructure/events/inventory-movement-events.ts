import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { newEventId } from '@pss/contracts';
import type { AuditActorInput } from '@pss/audit';
import { appendOutboxEvent } from '@pss/platform';
import type { MovingAverageResult } from '../../domain/rules/moving-average-cost';

/** The published scales, from `MVP_PLAN.md` §5: money 2 places, quantity 3 places. */
const MONEY_SCALE = 2;
const QUANTITY_SCALE = 3;

/**
 * The three inventory events, published from the movement's own transaction.
 *
 * `INVENTORY_RECEIVED`, `INVENTORY_ISSUED` and `INVENTORY_ADJUSTED` are what make the demo's
 * accounting chain real: Finance's posting rules switch on them (MVP_PLAN §8), so a receipt has to
 * carry a value and a handover has to carry a cost, or gross profit is revenue with no cost against
 * it. They are appended through `appendOutboxEvent` inside the transaction that writes the movement
 * rows — an event that committed separately from its fact is a reconciliation problem, not a retry
 * problem (AGENTS.md §3.5).
 *
 * `sourceType` and the quantities are formatted here, at the one boundary where a `numeric` becomes
 * the wire format, rather than in each command. The fixed scales are the contract's, not the
 * database column's: a quantity is always 3 places and money always 2, so a consumer never re-rounds
 * and a payload cannot be a valid string at one scale and invalid at another.
 */
export interface InventoryMovementFacts extends MovingAverageResult {
  movementId: string;
  productId: string;
  uom: string;
  qty: string;
}

export interface InventoryEventContext {
  organizationId: string;
  warehouseId: string;
  businessDate: string;
  sourceId: string;
  /** The request that caused the movement, so the event points back at the HTTP call or job. */
  causationId: string;
  correlationId: string;
  /**
   * The same actor the audit entry records. Typed as the audit schema's own input so the event and the
   * trail cannot disagree about who did it — `EventActorSchema` and `AuditEntryInputSchema.actor`
   * describe the same four fields.
   */
  actor: AuditActorInput;
}

export type ReceiveSourceType = 'GOODS_RECEIPT' | 'WMS_RECEIPT';

/** `MoneyV1` in the published contracts: exactly 2 places, never an exponent, never negative zero. */
function money(value: string | null): string | null {
  return value === null ? null : fixed(new Decimal(value), MONEY_SCALE);
}

/** `QuantityV1`: exactly 3 places. */
function quantity(value: string): string {
  return fixed(new Decimal(value), QUANTITY_SCALE);
}

/**
 * Rounds half away from zero at the published scale and strips a negative zero, which
 * `SignedMoneyV1`/`SignedQuantityV1` both reject.
 *
 * Rounding rather than truncating is the point: the ledger's `unit_cost` carries 4 places
 * (`numeric(18,4)`) and the payload carries 2, so the value is genuinely re-scaled here. Truncating
 * would bias every published cost downwards.
 */
function fixed(value: Decimal, scale: number): string {
  return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).plus(0).toFixed(scale);
}

function envelope(
  eventType: 'INVENTORY_RECEIVED' | 'INVENTORY_ISSUED' | 'INVENTORY_ADJUSTED',
  context: InventoryEventContext,
  aggregateType: 'InventoryMovement' | 'StockAdjustment',
  aggregateId: string,
  payload: Record<string, unknown>,
) {
  return {
    eventId: newEventId(), eventType, eventVersion: 1,
    occurredAt: new Date().toISOString(), businessDate: context.businessDate,
    organizationId: context.organizationId,
    aggregateType, aggregateId, aggregateVersion: 1,
    producer: 'inventory',
    ...(context.actor ? { actor: context.actor } : {}),
    correlationId: context.correlationId, causationId: context.causationId,
    payload,
  };
}

export async function publishInventoryReceived(
  tx: PoolClient,
  context: InventoryEventContext,
  sourceType: ReceiveSourceType,
  facts: InventoryMovementFacts[],
): Promise<void> {
  for (const fact of facts) {
    await appendOutboxEvent(tx, envelope('INVENTORY_RECEIVED', context, 'InventoryMovement', fact.movementId, {
      movementId: fact.movementId, warehouseId: context.warehouseId, productId: fact.productId, uom: fact.uom,
      qty: quantity(fact.qty),
      // `unitCost` is published at the payload's 2 places, one below the ledger's 4. `totalCost` is
      // the authoritative amount — Finance posts it, never qty × unitCost (MVP_PLAN §8) — and it
      // already carries the ledger's 2 places, so nothing the GL books loses a digit (MVP-OD-13).
      unitCost: money(fact.movementUnitCost),
      totalCost: money(fact.movementTotalCost),
      sourceType, sourceId: context.sourceId, businessDate: context.businessDate,
    }));
  }
}

export async function publishInventoryIssued(
  tx: PoolClient,
  context: InventoryEventContext,
  facts: InventoryMovementFacts[],
): Promise<void> {
  for (const fact of facts) {
    await appendOutboxEvent(tx, envelope('INVENTORY_ISSUED', context, 'InventoryMovement', fact.movementId, {
      movementId: fact.movementId, warehouseId: context.warehouseId, productId: fact.productId, uom: fact.uom,
      qty: quantity(fact.qty), unitCost: money(fact.movementUnitCost), totalCost: money(fact.movementTotalCost),
      // The MVP has one issue source: a sale handed over at the counter. A transfer or a return would
      // need its own `sourceType` in the published contract before it could be published.
      sourceType: 'SALES_FULFILLMENT', sourceId: context.sourceId, businessDate: context.businessDate,
    }));
  }
}

export interface InventoryAdjustmentFact extends InventoryMovementFacts {
  reasonCode: string;
}

export async function publishInventoryAdjusted(
  tx: PoolClient,
  context: InventoryEventContext,
  facts: InventoryAdjustmentFact[],
): Promise<void> {
  for (const fact of facts) {
    await appendOutboxEvent(tx, envelope('INVENTORY_ADJUSTED', context, 'StockAdjustment', fact.movementId, {
      adjustmentId: fact.movementId, warehouseId: context.warehouseId, productId: fact.productId, uom: fact.uom,
      qtyDelta: quantity(fact.qty), unitCost: money(fact.movementUnitCost),
      totalCostDelta: money(fact.movementTotalCost),
      reasonCode: fact.reasonCode, businessDate: context.businessDate,
    }));
  }
}
