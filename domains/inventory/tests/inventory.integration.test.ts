import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import {
  adjustStock, issueInventory, listAdjustmentReasons, listStockBalances, listStockMovements,
  receiveStock, releaseReservation, reserveStock,
} from '../src/index';
import { applyAuditMigrations, applyDomainMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_inventory_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

const organizationId = randomUUID();
const warehouseId = randomUUID();

function actor() {
  return { userId: randomUUID(), roles: ['CASHIER'] };
}

function auditMeta() {
  return { actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const };
}

async function seedBalance(productId: string, uom: string, qtyOnHand: string) {
  await pool.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 1)`,
    [randomUUID(), organizationId, warehouseId, productId, uom, qtyOnHand],
  );
}

async function balanceOf(productId: string): Promise<{ qty_on_hand: string; qty_reserved: string; avg_unit_cost: string | null }> {
  const result = await pool.query<{ qty_on_hand: string; qty_reserved: string; avg_unit_cost: string | null }>(
    `SELECT qty_on_hand, qty_reserved, avg_unit_cost FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2`,
    [warehouseId, productId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected a stock_balance row to exist.');
  return row;
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });

  // The whole ordered list, not a hardcoded pair: a fixture that names its migrations stops
  // running the ones added after it, which is what makes editing a shipped migration look like the
  // shortest path (MIG-RISK-AUD-001, and the reason apply-migrations.mjs reads the directory).
  await applyDomainMigrations((sql) => pool.query(sql), 'inventory');

  // Every command audits through @pss/audit's withAuditedTransaction/runAuditedWork, which
  // inserts into audit.audit_entry — so that table must exist here too. The whole audit domain
  // is replayed, not one file: a fixture that applies only 0001 is what made amending a shipped
  // migration look safe (MIG-RISK-AUD-001).
  await applyAuditMigrations(pool);

  // Every movement now appends its event through `appendOutboxEvent`, which writes
  // `platform.outbox_event` — so the platform schema is a prerequisite here too, and the whole
  // ordered list of it for the same reason audit's is replayed whole.
  await applyDomainMigrations((sql) => pool.query(sql), 'platform');

}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('inventory: reserveStock', () => {
  it('reserves exactly the requested qty when stock is sufficient', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'PCS', '10.000');

    const referenceId = randomUUID();
    const result = await reserveStock(pool, undefined, {
      organizationId,
      warehouseId,
      referenceType: 'POS_CHECKOUT',
      referenceId,
      lines: [{ productId, uom: 'PCS', qty: '4.000' }],
      actor: actor(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: 'WEB',
    });

    expect(result.reservationIds).toHaveLength(1);
    const balance = await balanceOf(productId);
    expect(balance.qty_reserved).toBe('4.000');
    expect(balance.qty_on_hand).toBe('10.000');

    const reservation = await pool.query(
      `SELECT status, qty FROM inventory.stock_reservation WHERE id = $1`,
      [result.reservationIds[0]],
    );
    expect(reservation.rows[0]).toMatchObject({ status: 'ACTIVE', qty: '4.000' });

    const auditEntries = await pool.query(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'STOCK_RESERVED'`,
      [referenceId],
    );
    expect(auditEntries.rowCount).toBe(1);
  });

  it('is all-or-nothing: a short line leaves every other line unreserved', async () => {
    const sufficientProductId = randomUUID();
    const shortProductId = randomUUID();
    await seedBalance(sufficientProductId, 'PCS', '10.000');
    await seedBalance(shortProductId, 'PCS', '2.000');

    const referenceId = randomUUID();
    const attempt = reserveStock(pool, undefined, {
      organizationId,
      warehouseId,
      referenceType: 'POS_CHECKOUT',
      referenceId,
      lines: [
        { productId: sufficientProductId, uom: 'PCS', qty: '3.000' },
        { productId: shortProductId, uom: 'PCS', qty: '5.000' },
      ],
      actor: actor(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: 'WEB',
    });

    await expect(attempt).rejects.toThrow(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const sufficientBalance = await balanceOf(sufficientProductId);
    expect(sufficientBalance.qty_reserved).toBe('0.000');
    const shortBalance = await balanceOf(shortProductId);
    expect(shortBalance.qty_reserved).toBe('0.000');

    const reservations = await pool.query(
      `SELECT count(*)::int AS count FROM inventory.stock_reservation WHERE reference_id = $1`,
      [referenceId],
    );
    expect(reservations.rows[0].count).toBe(0);
  });
});

describe('inventory: releaseReservation', () => {
  it('returns reserved qty to available', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'PCS', '10.000');
    const referenceId = randomUUID();

    await reserveStock(pool, undefined, {
      organizationId,
      warehouseId,
      referenceType: 'POS_CHECKOUT',
      referenceId,
      lines: [{ productId, uom: 'PCS', qty: '6.000' }],
      actor: actor(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: 'WEB',
    });
    expect((await balanceOf(productId)).qty_reserved).toBe('6.000');

    const released = await releaseReservation(pool, undefined, {
      referenceType: 'POS_CHECKOUT',
      referenceId,
    });
    expect(released.releasedCount).toBe(1);

    const balance = await balanceOf(productId);
    expect(balance.qty_reserved).toBe('0.000');
    expect(balance.qty_on_hand).toBe('10.000');

    const reservation = await pool.query(
      `SELECT status, released_at FROM inventory.stock_reservation WHERE reference_id = $1`,
      [referenceId],
    );
    expect(reservation.rows[0].status).toBe('RELEASED');
    expect(reservation.rows[0].released_at).not.toBeNull();

    // Retrying an already-fully-released reference is a safe no-op, not an error.
    const secondRelease = await releaseReservation(pool, undefined, {
      referenceType: 'POS_CHECKOUT',
      referenceId,
    });
    expect(secondRelease.releasedCount).toBe(0);
  });
});

describe('inventory: issueInventory', () => {
  it('decrements on-hand and reserved and inserts a movement row after a reservation', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'PCS', '10.000');
    const referenceId = randomUUID();

    await reserveStock(pool, undefined, {
      organizationId,
      warehouseId,
      referenceType: 'POS_HANDOVER',
      referenceId,
      lines: [{ productId, uom: 'PCS', qty: '5.000' }],
      actor: actor(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: 'WEB',
    });

    const result = await issueInventory(pool, undefined, {
      organizationId,
      warehouseId,
      referenceType: 'POS_HANDOVER',
      referenceId,
      lines: [{ productId, uom: 'PCS', qty: '5.000' }],
    });
    expect(result.movementIds).toHaveLength(1);

    const balance = await balanceOf(productId);
    expect(balance.qty_on_hand).toBe('5.000');
    expect(balance.qty_reserved).toBe('0.000');

    const movement = await pool.query(
      `SELECT movement_type, qty FROM inventory.stock_movement WHERE id = $1`,
      [result.movementIds[0]],
    );
    expect(movement.rows[0]).toMatchObject({ movement_type: 'ISSUE', qty: '5.000' });

    const reservation = await pool.query(
      `SELECT status FROM inventory.stock_reservation WHERE reference_id = $1`,
      [referenceId],
    );
    expect(reservation.rows[0].status).toBe('CONSUMED');

    const auditEntries = await pool.query(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'INVENTORY_ISSUED'`,
      [referenceId],
    );
    expect(auditEntries.rowCount).toBe(1);
  });
});

describe('inventory: receiveStock', () => {
  it('increases on-hand stock and records a RECEIVE movement (WMS-003 no-PO slice)', async () => {
    const productId = randomUUID();
    const referenceId = randomUUID();
    const result = await receiveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'WMS_RECEIVING', referenceId, sourceType: 'WMS_RECEIPT',
      lines: [{ productId, uom: 'KARTON', qty: '15', unitCost: null }],
    });
    expect(result.movementIds).toHaveLength(1);
    const balance = await balanceOf(productId);
    expect(balance.qty_on_hand).toBe('15.000');
    const movement = await pool.query(`SELECT movement_type, qty FROM inventory.stock_movement WHERE id = $1`, [result.movementIds[0]]);
    expect(movement.rows[0]).toMatchObject({ movement_type: 'RECEIVE', qty: '15.000' });
  });
});

/** A back-office goods receipt, the way the /kantor Terima Barang screen sends one. */
function receipt(lines: { productId: string; uom: string; qty: string; unitCost?: string | null }[], overrides: Record<string, unknown> = {}) {
  return receiveStock(pool, undefined, {
    organizationId,
    warehouseId,
    referenceType: 'GOODS_RECEIPT',
    referenceId: randomUUID(),
    sourceType: 'GOODS_RECEIPT',
    ...overrides,
    lines,
  });
}

/** A physical WMS scan: same quantity movement, no cost, and the event says so. */
function warehouseReceipt(lines: { productId: string; uom: string; qty: string }[]) {
  return receiveStock(pool, undefined, {
    organizationId,
    warehouseId,
    referenceType: 'WMS_RECEIPT',
    referenceId: randomUUID(),
    sourceType: 'WMS_RECEIPT',
    lines: lines.map((line) => ({ ...line, unitCost: null })),
  });
}

async function outboxPayloads(eventType: string, productId?: string) {
  const result = await pool.query<{ envelope: { payload: Record<string, unknown> } }>(
    `SELECT envelope FROM platform.outbox_event WHERE event_type = $1
       AND ($2::text IS NULL OR envelope->'payload'->>'productId' = $2::text)
     ORDER BY created_at, event_id`,
    [eventType, productId ?? null],
  );
  return result.rows.map((row) => row.envelope.payload);
}

describe('inventory: receiveStock with costing and INVENTORY_RECEIVED', () => {
  it('values a receipt, stores the new average, and publishes the movement with its cost', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'KARTON', qty: '10', unitCost: '100' }], { businessDate: '2026-10-01' });
    const second = await receipt([{ productId, uom: 'KARTON', qty: '10', unitCost: '120' }], { businessDate: '2026-10-01' });

    // INV-003.AC01: 10 @ 100 then 10 @ 120 averages to 110.
    expect((await balanceOf(productId)).avg_unit_cost).toBe('110.0000');

    const movement = await pool.query<{ unit_cost: string; total_cost: string }>(
      'SELECT unit_cost, total_cost FROM inventory.stock_movement WHERE id = $1', [second.movementIds[0]],
    );
    expect(movement.rows[0]).toMatchObject({ unit_cost: '120.0000', total_cost: '1200.00' });

    const last = (await outboxPayloads('INVENTORY_RECEIVED', productId)).at(-1);
    expect(last).toMatchObject({
      warehouseId, productId, uom: 'KARTON', qty: '10.000',
      unitCost: '120.00', totalCost: '1200.00', sourceType: 'GOODS_RECEIPT', businessDate: '2026-10-01',
    });
  });

  it('records an unvalued receipt without moving the average, and says so in the event', async () => {
    const productId = randomUUID();
    await warehouseReceipt([{ productId, uom: 'PCS', qty: '20' }]);

    const balance = await balanceOf(productId);
    expect(balance.qty_on_hand).toBe('20.000');
    expect(balance.avg_unit_cost).toBeNull();

    const movement = await pool.query<{ unit_cost: string | null; total_cost: string | null }>(
      'SELECT unit_cost, total_cost FROM inventory.stock_movement WHERE product_id = $1', [productId],
    );
    expect(movement.rows[0]).toMatchObject({ unit_cost: null, total_cost: null });

    // A null cost is what finance routes to its exception queue; it must not become a zero.
    expect(await outboxPayloads('INVENTORY_RECEIVED', productId)).toEqual([
      expect.objectContaining({ unitCost: null, totalCost: null, sourceType: 'WMS_RECEIPT' }),
    ]);
  });

  it('values a receipt onto an empty balance even when no cost was ever recorded before', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'PCS', qty: '24', unitCost: '9750' }]);
    expect((await balanceOf(productId)).avg_unit_cost).toBe('9750.0000');
  });

  it('leaves a valued receipt unvalued when unvalued stock is already on hand (MVP-OD-15)', async () => {
    const productId = randomUUID();
    await warehouseReceipt([{ productId, uom: 'PCS', qty: '100' }]);

    const valued = await receipt([{ productId, uom: 'PCS', qty: '50', unitCost: '10000' }]);

    // Valuing that quantity is a revaluation the MVP does not have. The movement stays unvalued
    // rather than being averaged to 3333.33, which would post a made-up amount to the GL.
    const movement = await pool.query<{ unit_cost: string | null; total_cost: string | null }>(
      'SELECT unit_cost, total_cost FROM inventory.stock_movement WHERE id = $1', [valued.movementIds[0]],
    );
    expect(movement.rows[0]).toMatchObject({ unit_cost: null, total_cost: null });
    expect((await balanceOf(productId)).avg_unit_cost).toBeNull();
  });

  it('writes the movement and its event in one transaction: a rejected line leaves neither', async () => {
    const productId = randomUUID();
    const outboxBefore = await pool.query<{ total: string }>('SELECT count(*) AS total FROM platform.outbox_event');
    const movementsBefore = await pool.query<{ total: string }>('SELECT count(*) AS total FROM inventory.stock_movement');

    // The second line is a negative receipt, which the command refuses after the first line has
    // already written a movement — so the first line's event must roll back with it.
    await expect(receipt([
      { productId, uom: 'PCS', qty: '5', unitCost: '2000' },
      { productId, uom: 'PCS', qty: '-1', unitCost: '2000' },
    ])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const outboxAfter = await pool.query<{ total: string }>('SELECT count(*) AS total FROM platform.outbox_event');
    const movementsAfter = await pool.query<{ total: string }>('SELECT count(*) AS total FROM inventory.stock_movement');
    expect(outboxAfter.rows[0]!.total).toBe(outboxBefore.rows[0]!.total);
    expect(movementsAfter.rows[0]!.total).toBe(movementsBefore.rows[0]!.total);
    // The balance row the first line created rolled back with it, so the second attempt starts clean.
    const balance = await pool.query(
      'SELECT count(*)::int AS count FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2',
      [warehouseId, productId],
    );
    expect(balance.rows[0]?.count).toBe(0);
  });

  it('rejects a receipt of a negative quantity with a field message', async () => {
    const attempt = await receipt([{ productId: randomUUID(), uom: 'PCS', qty: '-5', unitCost: '1000' }])
      .catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
    expect((attempt as DomainError).fieldErrors?.[0]?.path).toBe('lines[0].qty');
  });

  it('rejects a source type outside the event contract, rather than publishing an unknown one', async () => {
    const attempt = await receipt([{ productId: randomUUID(), uom: 'PCS', qty: '1', unitCost: '1' }], {
      sourceType: 'MANUAL_ENTRY',
    }).catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
  });
});

describe('inventory: a sale carries a cost (INVENTORY_ISSUED)', () => {
  it('values the handover at the current average and publishes it', async () => {
    const productId = randomUUID();
    const referenceId = randomUUID();
    await receipt([{ productId, uom: 'KARTON', qty: '100', unitCost: '950' }], { businessDate: '2026-10-01' });
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_HANDOVER', referenceId,
      lines: [{ productId, uom: 'KARTON', qty: '5' }], ...auditMeta(),
    });

    const issued = await issueInventory(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_HANDOVER', referenceId, businessDate: '2026-10-01',
      lines: [{ productId, uom: 'KARTON', qty: '5' }],
    });

    const movement = await pool.query<{ unit_cost: string; total_cost: string }>(
      'SELECT unit_cost, total_cost FROM inventory.stock_movement WHERE id = $1', [issued.movementIds[0]],
    );
    expect(movement.rows[0]).toMatchObject({ unit_cost: '950.0000', total_cost: '4750.00' });
    // An issue does not re-average.
    expect((await balanceOf(productId)).avg_unit_cost).toBe('950.0000');

    expect((await outboxPayloads('INVENTORY_ISSUED', productId))[0]).toMatchObject({
      qty: '5.000', unitCost: '950.00', totalCost: '4750.00',
      sourceType: 'SALES_FULFILLMENT', sourceId: referenceId, businessDate: '2026-10-01',
    });
  });

  it('publishes an unvalued issue when the balance was never valued, instead of a zero cost', async () => {
    const productId = randomUUID();
    const referenceId = randomUUID();
    await warehouseReceipt([{ productId, uom: 'PCS', qty: '10' }]);
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_HANDOVER', referenceId,
      lines: [{ productId, uom: 'PCS', qty: '2' }], ...auditMeta(),
    });
    await issueInventory(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_HANDOVER', referenceId,
      lines: [{ productId, uom: 'PCS', qty: '2' }],
    });

    expect((await outboxPayloads('INVENTORY_ISSUED', productId))[0]).toMatchObject({ unitCost: null, totalCost: null });
  });

  it('refuses an issue of a non-positive quantity', async () => {
    const productId = randomUUID();
    const referenceId = randomUUID();
    await receipt([{ productId, uom: 'PCS', qty: '10', unitCost: '500' }]);
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_HANDOVER', referenceId,
      lines: [{ productId, uom: 'PCS', qty: '2' }], ...auditMeta(),
    });
    const attempt = await issueInventory(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_HANDOVER', referenceId,
      lines: [{ productId, uom: 'PCS', qty: '0' }],
    }).catch((error) => error);
    expect((attempt as DomainError).fieldErrors?.[0]?.code).toBe('not_positive');
  });
});

describe('inventory: adjustStock reasons, costing and INVENTORY_ADJUSTED', () => {
  it('refuses a reason code that is not in the reference table, and names the field', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'KARTON', '10');

    const attempt = await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'BACKOFFICE_ADJUSTMENT', referenceId: randomUUID(),
      lines: [{ productId, uom: 'KARTON', qtyDelta: '-1', reasonCode: 'RUSAK' }],
    }).catch((error) => error);

    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
    expect((attempt as DomainError).fieldErrors?.[0]?.path).toBe('lines[0].reasonCode');
    // Nothing moved: the reason is checked before the quantity is.
    expect((await balanceOf(productId)).qty_on_hand).toBe('10.000');
  });

  it('refuses a zero adjustment rather than writing a movement and an event for nothing', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'KARTON', '10');
    const attempt = await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'BACKOFFICE_ADJUSTMENT', referenceId: randomUUID(),
      lines: [{ productId, uom: 'KARTON', qtyDelta: '0', reasonCode: 'RC-INV-COUNT_VARIANCE' }],
    }).catch((error) => error);
    expect((attempt as DomainError).fieldErrors?.[0]?.code).toBe('zero');
  });

  it('values a shortage at the current average and publishes a signed cost delta', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'KARTON', qty: '40', unitCost: '2500' }], { businessDate: '2026-10-02' });

    const referenceId = randomUUID();
    const adjusted = await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'BACKOFFICE_ADJUSTMENT', referenceId, businessDate: '2026-10-02',
      lines: [{ productId, uom: 'KARTON', qtyDelta: '-3', reasonCode: 'RC-INV-DAMAGED' }],
    });

    const movement = await pool.query<{ unit_cost: string; total_cost: string; reason_code: string }>(
      'SELECT unit_cost, total_cost, reason_code FROM inventory.stock_movement WHERE id = $1',
      [adjusted.movementIds[0]],
    );
    expect(movement.rows[0]).toMatchObject({
      unit_cost: '2500.0000', total_cost: '-7500.00', reason_code: 'RC-INV-DAMAGED',
    });

    expect((await outboxPayloads('INVENTORY_ADJUSTED', productId))[0]).toEqual({
      adjustmentId: adjusted.movementIds[0], warehouseId, productId, uom: 'KARTON', qtyDelta: '-3.000',
      unitCost: '2500.00', totalCostDelta: '-7500.00', reasonCode: 'RC-INV-DAMAGED', businessDate: '2026-10-02',
    });

    const audit = await pool.query(
      `SELECT count(*)::int AS count FROM audit.audit_entry
       WHERE action = 'INVENTORY_ADJUSTED' AND entity_id = $1`,
      [referenceId],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('publishes a surplus as a positive cost delta', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'KARTON', qty: '40', unitCost: '2500' }], { businessDate: '2026-10-02' });
    await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'BACKOFFICE_ADJUSTMENT', referenceId: randomUUID(),
      businessDate: '2026-10-02',
      lines: [{ productId, uom: 'KARTON', qtyDelta: '2', reasonCode: 'RC-INV-FOUND' }],
    });
    expect((await outboxPayloads('INVENTORY_ADJUSTED', productId))[0])
      .toMatchObject({ qtyDelta: '2.000', totalCostDelta: '5000.00' });
  });

  it('records the reason label, not just the code, in the audit entry', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'KARTON', '10');
    const referenceId = randomUUID();
    await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'BACKOFFICE_ADJUSTMENT', referenceId,
      lines: [{ productId, uom: 'KARTON', qtyDelta: '-1', reasonCode: 'RC-INV-LOST' }],
    });
    const audit = await pool.query<{ changes: { path: string; after: string }[] }>(
      `SELECT changes FROM audit.audit_entry WHERE action = 'INVENTORY_ADJUSTED' AND entity_id = $1`,
      [referenceId],
    );
    expect(audit.rows[0]?.changes).toContainEqual(
      expect.objectContaining({ path: 'lines[0].reasonCode', after: 'Barang hilang' }),
    );
  });
});

describe('inventory: the reason vocabulary comes from the reference table', () => {
  it('offers the registered Appendix F.3 codes with Indonesian labels, and never a raw code', async () => {
    const reasons = await listAdjustmentReasons(pool);
    const byCode = new Map(reasons.map((reason) => [reason.code, reason.label]));

    expect(byCode.get('RC-INV-DAMAGED')).toBe('Barang rusak');
    expect(byCode.get('RC-INV-LOST')).toBe('Barang hilang');
    expect(byCode.get('RC-INV-COUNT_VARIANCE')).toBe('Selisih hasil hitung fisik');
    // F.3 requires every list to carry an …_OTHER.
    expect(byCode.has('RC-INV-OTHER')).toBe(true);
    // The codes domains/wms already writes are present, or WMS's discrepancy flow would be refused.
    expect(byCode.has('RC-WMS-DISC_MISSING')).toBe(true);
    expect(reasons.every((reason) => reason.label.trim().length > 0 && !reason.label.startsWith('RC-'))).toBe(true);
  });
});

describe('inventory: listStockBalances', () => {
  it('reports the average cost and the value, and totals the whole filtered set', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'KARTON', qty: '24', unitCost: '9750' }]);

    const page = await listStockBalances(pool, undefined, { organizationId, warehouseId, productId });
    expect(page.items[0]).toMatchObject({
      productId, uom: 'KARTON', qtyOnHand: '24.000', qtyReserved: '0.000',
      avgUnitCost: '9750.0000', stockValue: '234000.00',
    });
    expect(page.totalValue).toBe('234000.00');
  });

  it('reports a null value for an unvalued balance, and refuses to total it', async () => {
    const productId = randomUUID();
    await warehouseReceipt([{ productId, uom: 'PCS', qty: '30' }]);

    const page = await listStockBalances(pool, undefined, { organizationId, warehouseId, productId });
    expect(page.items[0]).toMatchObject({ avgUnitCost: null, stockValue: null });
    // A total that silently omitted unvalued stock would understate inventory value.
    expect(page.totalValue).toBeNull();

    const unvalued = await listStockBalances(pool, undefined, { organizationId, warehouseId, unvaluedOnly: true });
    expect(unvalued.items.some((item) => item.productId === productId)).toBe(true);
  });

  it('filters by a low-stock threshold supplied by the caller, never a constant in the query', async () => {
    const short = randomUUID();
    const plentiful = randomUUID();
    await seedBalance(short, 'PCS', '3');
    await seedBalance(plentiful, 'PCS', '500');

    const low = await listStockBalances(pool, undefined, { organizationId, warehouseId, maxQty: '10' });
    expect(low.items.map((item) => item.productId)).toContain(short);
    expect(low.items.map((item) => item.productId)).not.toContain(plentiful);

    const stricter = await listStockBalances(pool, undefined, { organizationId, warehouseId, maxQty: '1' });
    expect(stricter.items.map((item) => item.productId)).not.toContain(short);
  });

  it('paginates, and shows another organization nothing at all', async () => {
    const otherOrganization = randomUUID();
    const products = [randomUUID(), randomUUID(), randomUUID()];
    for (const productId of products) {
      await pool.query(
        `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
         VALUES ($1, $2, $3, $4, 'PCS', 1, 0, 1)`,
        [randomUUID(), otherOrganization, warehouseId, productId],
      );
    }

    const page = await listStockBalances(pool, undefined, {
      organizationId: otherOrganization, warehouseId, pageSize: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    // A warehouse id is required, because MVP-OD-4 scopes the average and the value per warehouse:
    // an organization-wide total would need a rule for goods received at one and sold from another.
    expect((await listStockBalances(pool, undefined, { organizationId: randomUUID(), warehouseId })).total).toBe(0);
    const withoutWarehouse = await listStockBalances(pool, undefined, {
      organizationId: otherOrganization, warehouseId: undefined,
    }).catch((error) => error);
    expect((withoutWarehouse as DomainError).code).toBe('VALIDATION_FAILED');
  });
});

describe('inventory: listStockMovements', () => {
  it('lists a warehouse ledger newest first, with the reason label joined', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'KARTON', qty: '50', unitCost: '1000' }]);
    await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'BACKOFFICE_ADJUSTMENT', referenceId: randomUUID(),
      lines: [{ productId, uom: 'KARTON', qtyDelta: '-2', reasonCode: 'RC-INV-DAMAGED' }],
    });

    const page = await listStockMovements(pool, undefined, { organizationId, warehouseId, productId });
    expect(page.items[0]).toMatchObject({
      productId, movementType: 'ADJUSTMENT', qty: '-2.000', reasonCode: 'RC-INV-DAMAGED',
      reasonLabel: 'Barang rusak', unitCost: '1000.0000', totalCost: '-2000.00',
    });
    expect(page.items[1]).toMatchObject({ movementType: 'RECEIVE', reasonCode: null, reasonLabel: null });

    const byReason = await listStockMovements(pool, undefined, {
      organizationId, warehouseId, productId, reasonCode: 'RC-INV-DAMAGED',
    });
    expect(byReason.total).toBe(1);
  });

  it('filters by movement type, and shows another organization nothing', async () => {
    const productId = randomUUID();
    await receipt([{ productId, uom: 'PCS', qty: '10', unitCost: '500' }]);

    expect((await listStockMovements(pool, undefined, { organizationId, productId, movementType: 'RECEIVE' })).total).toBe(1);
    expect((await listStockMovements(pool, undefined, { organizationId, productId, movementType: 'ISSUE' })).total).toBe(0);
    expect((await listStockMovements(pool, undefined, { organizationId: randomUUID() })).total).toBe(0);
  });

  it('refuses a sort field that is not allow-listed', async () => {
    const attempt = await listStockMovements(pool, undefined, {
      organizationId, sort: 'created_at' as 'qty',
    }).catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
  });
});
