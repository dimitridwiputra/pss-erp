import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { adjustStock, issueInventory, receiveStock, releaseReservation, reserveStock } from '../src/index';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_inventory_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

const organizationId = randomUUID();
const warehouseId = randomUUID();

function actor() {
  return { userId: randomUUID(), roles: ['CASHIER'] };
}

async function seedBalance(productId: string, uom: string, qtyOnHand: string) {
  await pool.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 1)`,
    [randomUUID(), organizationId, warehouseId, productId, uom, qtyOnHand],
  );
}

async function balanceOf(productId: string): Promise<{ qty_on_hand: string; qty_reserved: string }> {
  const result = await pool.query<{ qty_on_hand: string; qty_reserved: string }>(
    `SELECT qty_on_hand, qty_reserved FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2`,
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

  for (const file of ['0001_inventory.sql', '0002_inventory_receive_adjust.sql']) {
    await pool.query(await readFile(
      new URL(`../infrastructure/database/migrations/${file}`, import.meta.url), 'utf8',
    ));
  }

  // Every command audits through @pss/audit's withAuditedTransaction/runAuditedWork, which
  // inserts into audit.audit_entry — so that table must exist here too. The whole audit domain
  // is replayed, not one file: a fixture that applies only 0001 is what made amending a shipped
  // migration look safe (MIG-RISK-AUD-001).
  await applyAuditMigrations(pool);

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
      organizationId, warehouseId, referenceType: 'WMS_RECEIVING', referenceId,
      lines: [{ productId, uom: 'KARTON', qty: '15' }],
    });
    expect(result.movementIds).toHaveLength(1);
    const balance = await balanceOf(productId);
    expect(balance.qty_on_hand).toBe('15.000');
    const movement = await pool.query(`SELECT movement_type, qty FROM inventory.stock_movement WHERE id = $1`, [result.movementIds[0]]);
    expect(movement.rows[0]).toMatchObject({ movement_type: 'RECEIVE', qty: '15.000' });
  });
});

describe('inventory: adjustStock', () => {
  it('applies a positive correction (surplus found)', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'KARTON', '10');
    const referenceId = randomUUID();
    await adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'WMS_DISCREPANCY', referenceId,
      lines: [{ productId, uom: 'KARTON', qtyDelta: '2', reasonCode: 'RC-WMS-DISC_EXCESS' }],
    });
    const balance = await balanceOf(productId);
    expect(balance.qty_on_hand).toBe('12.000');
  });

  it('rejects a negative correction that would drop on-hand below what is already reserved', async () => {
    const productId = randomUUID();
    await seedBalance(productId, 'KARTON', '10');
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'POS_SALE', referenceId: randomUUID(),
      lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor(),
      requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    await expect(adjustStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'WMS_DISCREPANCY', referenceId: randomUUID(),
      lines: [{ productId, uom: 'KARTON', qtyDelta: '-5', reasonCode: 'RC-WMS-DISC_MISSING' }],
    })).rejects.toThrow(DomainError);
    const balance = await balanceOf(productId);
    expect(balance.qty_on_hand).toBe('10.000'); // unchanged — rejected before commit
  });
});
