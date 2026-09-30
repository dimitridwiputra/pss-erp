import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveStock } from '@pss/inventory';
import {
  registerWarehouseLocation,
  setWarehouseLocationStatus,
  activateWarehouse,
  receiveGoods,
  putawayStock,
  allocatePickTask,
  confirmPickTask,
  submitCycleCount,
  reportStockDiscrepancy,
  resolveStockDiscrepancy,
  runReconciliation,
  getReconciliationResult,
  createWarehouseUnit,
  addWarehouseUnitLine,
  printLabel,
  getWarehouseDashboard,
  completePacking,
  stagePackage,
  loadPackage,
  syncOfflineConfirmations,
  heartbeatOperatorSession,
  getActiveOperators,
  logException,
  assignException,
  resolveException,
  getExceptionQueue,
  getWarehouseReport,
  getLocationUtilization,
  listWarehouseTasks,
} from '../src/index';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_wms_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

const organizationId = randomUUID();
const warehouseId = randomUUID();

function actor() {
  return { userId: randomUUID(), roles: ['WAREHOUSE_OPERATOR'] };
}

function code(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function registerReceivingLocation(): Promise<{ id: string; code: string }> {
  const receivingCode = code('RECV');
  const result = await registerWarehouseLocation(pool, undefined, {
    organizationId, warehouseId, code: receivingCode, type: 'RECEIVING', actor: actor(),
  });
  return { id: result.id, code: receivingCode };
}

async function registerBinLocation(): Promise<{ id: string; code: string }> {
  const binCode = code('BIN');
  const result = await registerWarehouseLocation(pool, undefined, {
    organizationId, warehouseId, code: binCode, type: 'BIN', actor: actor(),
  });
  return { id: result.id, code: binCode };
}

async function physicalStockOf(locationId: string, productId: string): Promise<{ qty_on_hand: string; qty_allocated: string } | undefined> {
  const result = await pool.query<{ qty_on_hand: string; qty_allocated: string }>(
    `SELECT qty_on_hand, qty_allocated FROM wms.physical_stock WHERE location_id = $1 AND product_id = $2`,
    [locationId, productId],
  );
  return result.rows[0];
}

async function financialBalanceOf(productId: string): Promise<{ qty_on_hand: string; qty_reserved: string } | undefined> {
  const result = await pool.query<{ qty_on_hand: string; qty_reserved: string }>(
    `SELECT qty_on_hand, qty_reserved FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2`,
    [warehouseId, productId],
  );
  return result.rows[0];
}

async function applyMigration(relativePath: string): Promise<void> {
  const sql = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  await pool.query(sql);
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

  // The whole audit domain, not one file: a fixture that replays only
  // 0001 is what made amending a shipped migration look safe (MIG-RISK-AUD-001).
  // The whole audit domain, not a hand-picked pair of its files. Replaying 0001 and 0002 by name
  // is what made amending a shipped migration look safe (MIG-RISK-AUD-001), and it broke as soon as
  // the domain grew a migration: 0002 alters a constraint the replayed 0001 no longer creates.
  await applyAuditMigrations(pool);

  await applyMigration('../../inventory/infrastructure/database/migrations/0001_inventory.sql');
  await applyMigration('../../inventory/infrastructure/database/migrations/0002_inventory_receive_adjust.sql');
  await applyMigration('../infrastructure/database/migrations/0001_wms.sql');
  await applyMigration('../infrastructure/database/migrations/0002_wms_reconciliation_and_units.sql');
  await applyMigration('../infrastructure/database/migrations/0003_wms_pack_stage_load.sql');
  await applyMigration('../infrastructure/database/migrations/0004_wms_presence_capacity_exceptions.sql');
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('wms: warehouse locations', () => {
  it('registers a location and a child under it', async () => {
    const zone = await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: code('ZONE'), type: 'ZONE', actor: actor() });
    const bin = await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: code('BIN'), type: 'BIN', parentLocationId: zone.id, actor: actor() });
    expect(bin.id).toBeTruthy();
  });

  it('rejects a duplicate code in the same warehouse', async () => {
    const sharedCode = code('DUP');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: sharedCode, type: 'BIN', actor: actor() });
    await expect(registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: sharedCode, type: 'BIN', actor: actor() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a parent that does not exist', async () => {
    await expect(registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: code('ORPHAN'), type: 'BIN', parentLocationId: randomUUID(), actor: actor() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to block a location that still holds physical stock', async () => {
    const receiving = await registerReceivingLocation();
    const productId = randomUUID();
    await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId, uom: 'KARTON', qty: '5' }], actor: actor() });

    await expect(setWarehouseLocationStatus(pool, undefined, { locationId: receiving.id, status: 'BLOCKED', actor: actor() })).rejects.toMatchObject({ code: 'LOCATION_NOT_EMPTY' });
  });

  it('allows blocking an empty location', async () => {
    const bin = await registerBinLocation();
    const result = await setWarehouseLocationStatus(pool, undefined, { locationId: bin.id, status: 'BLOCKED', actor: actor() });
    expect(result.status).toBe('BLOCKED');
  });
});

describe('wms: activateWarehouse', () => {
  it('blocks activation when physical and financial balances disagree, then allows it once matched', async () => {
    const productId = randomUUID();
    const bin = await registerBinLocation();

    await pool.query(
      `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
       VALUES ($1, $2, $3, $4, 'KARTON', 10, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, productId],
    );

    await expect(activateWarehouse(pool, undefined, { organizationId, warehouseId, actor: actor() })).rejects.toMatchObject({ code: 'WMS_ACTIVATION_BLOCKED' });

    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 10, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, bin.id, productId],
    );

    const result = await activateWarehouse(pool, undefined, { organizationId, warehouseId, actor: actor() });
    expect(result.warehouseId).toBe(warehouseId);

    const config = await pool.query(`SELECT wms_enabled FROM wms.warehouse_config WHERE warehouse_id = $1`, [warehouseId]);
    expect(config.rows[0].wms_enabled).toBe(true);
  });
});

describe('wms: receiveGoods', () => {
  it('increases physical stock, posts the financial receipt, and creates a putaway task', async () => {
    const receiving = await registerReceivingLocation();
    const productId = randomUUID();
    const referenceId = randomUUID();

    const result = await receiveGoods(pool, undefined, {
      organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId,
      lines: [{ productId, uom: 'KARTON', qty: '20' }], actor: actor(),
    });
    expect(result.receiveTaskIds).toHaveLength(1);
    expect(result.putawayTaskIds).toHaveLength(1);

    expect((await physicalStockOf(receiving.id, productId))?.qty_on_hand).toBe('20.000');
    expect((await financialBalanceOf(productId))?.qty_on_hand).toBe('20.000');

    const putawayTask = await pool.query(`SELECT status, type FROM wms.warehouse_task WHERE id = $1`, [result.putawayTaskIds[0]]);
    expect(putawayTask.rows[0]).toMatchObject({ status: 'CREATED', type: 'PUTAWAY' });
  });

  it('rejects receiving into a non-RECEIVING location', async () => {
    const bin = await registerBinLocation();
    await expect(receiveGoods(pool, undefined, {
      organizationId, warehouseId, locationCode: bin.code, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(),
      lines: [{ productId: randomUUID(), uom: 'KARTON', qty: '1' }], actor: actor(),
    })).rejects.toMatchObject({ code: 'LOCATION_INVALID' });
  });
});

describe('wms: putawayStock', () => {
  it('moves physical stock between locations without touching the financial balance', async () => {
    const receiving = await registerReceivingLocation();
    const bin = await registerBinLocation();
    const productId = randomUUID();
    const referenceId = randomUUID();

    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId, lines: [{ productId, uom: 'KARTON', qty: '12' }], actor: actor() });
    const financialBefore = await financialBalanceOf(productId);

    const putaway = await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: bin.code, qtyConfirmed: '12', actor: actor() });
    expect(putaway.status).toBe('COMPLETED');

    expect((await physicalStockOf(receiving.id, productId))?.qty_on_hand).toBe('0.000');
    expect((await physicalStockOf(bin.id, productId))?.qty_on_hand).toBe('12.000');
    expect((await financialBalanceOf(productId))?.qty_on_hand).toBe(financialBefore?.qty_on_hand);
  });

  it('rejects an unknown destination location code', async () => {
    const receiving = await registerReceivingLocation();
    const productId = randomUUID();
    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId, uom: 'KARTON', qty: '4' }], actor: actor() });
    await expect(putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: 'NO-SUCH-CODE', qtyConfirmed: '4', actor: actor() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('wms: allocatePickTask + confirmPickTask', () => {
  it('allocates across a bin, is idempotent on replay, rejects a mismatched scan, and completes a correct pick', async () => {
    const receiving = await registerReceivingLocation();
    const bin = await registerBinLocation();
    const productId = randomUUID();
    const receiveReferenceId = randomUUID();
    const pickReferenceId = randomUUID();

    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId: receiveReferenceId, lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor() });
    await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: bin.code, qtyConfirmed: '8', actor: actor() });

    // A pick's `issueInventory` call requires a pre-existing reservation for the same reference —
    // in the real flow this is created by whoever released the fulfillment (see pick-task.ts docstring).
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId,
      lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });

    const allocation = await allocatePickTask(pool, undefined, {
      organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId,
      lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor(),
    });
    expect(allocation.taskIds).toHaveLength(1);
    expect(allocation.shortLines).toHaveLength(0);
    expect((await physicalStockOf(bin.id, productId))?.qty_allocated).toBe('8.000');

    const replay = await allocatePickTask(pool, undefined, {
      organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId,
      lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor(),
    });
    expect(replay).toEqual({ taskIds: [], shortLines: [] });

    const taskId = allocation.taskIds[0]!;
    await expect(confirmPickTask(pool, undefined, { taskId, scannedLocationCode: 'WRONG-CODE', scannedProductId: productId, qtyConfirmed: '8', actor: actor() })).rejects.toMatchObject({ code: 'SCAN_MISMATCH' });
    const afterMismatch = await pool.query(`SELECT status FROM wms.warehouse_task WHERE id = $1`, [taskId]);
    expect(afterMismatch.rows[0].status).toBe('CREATED');

    const confirmed = await confirmPickTask(pool, undefined, { taskId, scannedLocationCode: bin.code, scannedProductId: productId, qtyConfirmed: '8', actor: actor() });
    expect(confirmed.status).toBe('COMPLETED');

    expect((await physicalStockOf(bin.id, productId))?.qty_on_hand).toBe('0.000');
    expect((await financialBalanceOf(productId))?.qty_on_hand).toBe('0.000');
    const reservation = await pool.query(`SELECT status FROM inventory.stock_reservation WHERE reference_id = $1`, [pickReferenceId]);
    expect(reservation.rows[0].status).toBe('CONSUMED');
  });

  it('requires a reason code for a short pick', async () => {
    const receiving = await registerReceivingLocation();
    const bin = await registerBinLocation();
    const productId = randomUUID();
    const pickReferenceId = randomUUID();

    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId, uom: 'KARTON', qty: '5' }], actor: actor() });
    await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: bin.code, qtyConfirmed: '5', actor: actor() });
    await reserveStock(pool, undefined, { organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId, lines: [{ productId, uom: 'KARTON', qty: '5' }], actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'API' });
    const allocation = await allocatePickTask(pool, undefined, { organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId, lines: [{ productId, uom: 'KARTON', qty: '5' }], actor: actor() });

    await expect(confirmPickTask(pool, undefined, { taskId: allocation.taskIds[0]!, scannedLocationCode: bin.code, scannedProductId: productId, qtyConfirmed: '3', actor: actor() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('wms: submitCycleCount', () => {
  it('detects a variance and opens a discrepancy report without leaking the system qty', async () => {
    const bin = await registerBinLocation();
    const productId = randomUUID();
    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 10, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, bin.id, productId],
    );

    const result = await submitCycleCount(pool, undefined, { organizationId, warehouseId, locationCode: bin.code, productId, uom: 'KARTON', countedQty: '7', actor: actor() });
    expect(result.varianceDetected).toBe(true);
    expect(result.discrepancyReportId).toBeTruthy();
    expect(Object.keys(result).sort()).toEqual(['discrepancyReportId', 'taskId', 'varianceDetected']);

    const report = await pool.query(`SELECT report_type, qty, status FROM wms.stock_discrepancy_report WHERE id = $1`, [result.discrepancyReportId]);
    expect(report.rows[0]).toMatchObject({ report_type: 'MISSING', qty: '3.000', status: 'REPORTED' });
  });

  it('reports no variance when the count matches', async () => {
    const bin = await registerBinLocation();
    const productId = randomUUID();
    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 4, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, bin.id, productId],
    );

    const result = await submitCycleCount(pool, undefined, { organizationId, warehouseId, locationCode: bin.code, productId, uom: 'KARTON', countedQty: '4', actor: actor() });
    expect(result.varianceDetected).toBe(false);
    expect(result.discrepancyReportId).toBeUndefined();
  });
});

describe('wms: reportStockDiscrepancy + resolveStockDiscrepancy', () => {
  it('requires evidence for a DAMAGED report', async () => {
    const bin = await registerBinLocation();
    await expect(reportStockDiscrepancy(pool, undefined, {
      organizationId, warehouseId, locationCode: bin.code, productId: randomUUID(), uom: 'KARTON',
      reportType: 'DAMAGED', qty: '2', reasonCode: 'RC-WMS-DISC_DAMAGED', actor: actor(),
    })).rejects.toMatchObject({ code: 'EVIDENCE_PHOTO_REQUIRED' });
  });

  it('applies an EXCESS adjustment exactly once', async () => {
    const bin = await registerBinLocation();
    const productId = randomUUID();
    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 5, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, bin.id, productId],
    );
    await pool.query(
      `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
       VALUES ($1, $2, $3, $4, 'KARTON', 5, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, productId],
    );

    const report = await reportStockDiscrepancy(pool, undefined, {
      organizationId, warehouseId, locationCode: bin.code, productId, uom: 'KARTON',
      reportType: 'EXCESS', qty: '2', reasonCode: 'RC-WMS-DISC_EXCESS', actor: actor(),
    });

    const resolved = await resolveStockDiscrepancy(pool, undefined, { reportId: report.id, decision: 'ADJUST', actor: actor() });
    expect(resolved.status).toBe('ADJUSTED');
    expect((await physicalStockOf(bin.id, productId))?.qty_on_hand).toBe('7.000');
    expect((await financialBalanceOf(productId))?.qty_on_hand).toBe('7.000');

    await expect(resolveStockDiscrepancy(pool, undefined, { reportId: report.id, decision: 'ADJUST', actor: actor() })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('rejects a report with no further state change', async () => {
    const bin = await registerBinLocation();
    const productId = randomUUID();
    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 5, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, bin.id, productId],
    );

    const report = await reportStockDiscrepancy(pool, undefined, {
      organizationId, warehouseId, locationCode: bin.code, productId, uom: 'KARTON',
      reportType: 'MISSING', qty: '1', reasonCode: 'RC-WMS-DISC_MISSING', actor: actor(),
    });
    const resolved = await resolveStockDiscrepancy(pool, undefined, { reportId: report.id, decision: 'REJECT', actor: actor() });
    expect(resolved.status).toBe('REJECTED');
    expect((await physicalStockOf(bin.id, productId))?.qty_on_hand).toBe('5.000');
  });

  it('rejects ADJUST on a WRONG_LOCATION report', async () => {
    const bin = await registerBinLocation();
    const productId = randomUUID();
    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 5, 0, 1)`,
      [randomUUID(), organizationId, warehouseId, bin.id, productId],
    );
    const report = await reportStockDiscrepancy(pool, undefined, {
      organizationId, warehouseId, locationCode: bin.code, productId, uom: 'KARTON',
      reportType: 'WRONG_LOCATION', qty: '1', reasonCode: 'RC-WMS-DISC_WRONG_LOCATION', actor: actor(),
    });
    await expect(resolveStockDiscrepancy(pool, undefined, { reportId: report.id, decision: 'ADJUST', actor: actor() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('wms: runReconciliation + getReconciliationResult', () => {
  it('detects a variance, is idempotent per (warehouse, date), and returns immutable results', async () => {
    // A dedicated warehouseId keeps this aggregation-across-the-whole-warehouse report isolated
    // from the residual physical/financial mismatches other describe blocks intentionally leave
    // behind (e.g. a rejected discrepancy report, or a blind count with no matching financial row).
    const reconciliationWarehouseId = randomUUID();
    const bin = await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: reconciliationWarehouseId, code: code('RBIN'), type: 'BIN', actor: actor() });
    const balancedProductId = randomUUID();
    const mismatchedProductId = randomUUID();

    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 10, 0, 1), ($6, $2, $3, $4, $7, 'KARTON', 6, 0, 1)`,
      [randomUUID(), organizationId, reconciliationWarehouseId, bin.id, balancedProductId, randomUUID(), mismatchedProductId],
    );
    await pool.query(
      `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
       VALUES ($1, $2, $3, $4, 'KARTON', 10, 0, 1)`,
      [randomUUID(), organizationId, reconciliationWarehouseId, balancedProductId],
    );
    // mismatchedProductId deliberately has no inventory.stock_balance row at all (financial = 0).

    const businessDate = '2026-01-15';
    const result = await runReconciliation(pool, undefined, { organizationId, warehouseId: reconciliationWarehouseId, businessDate, actor: actor() });
    expect(result.varianceCount).toBe(1);
    expect(result.items).toEqual([{ productId: mismatchedProductId, physicalQty: '6.000', financialQty: '0.000', variance: '6.000' }]);

    const rerun = await runReconciliation(pool, undefined, { organizationId, warehouseId: reconciliationWarehouseId, businessDate, actor: actor() });
    expect(rerun.id).toBe(result.id);
    expect(rerun.varianceCount).toBe(1);

    const fetched = await getReconciliationResult(pool, { warehouseId: reconciliationWarehouseId, businessDate });
    expect(fetched?.id).toBe(result.id);

    const otherDate = await getReconciliationResult(pool, { warehouseId: reconciliationWarehouseId, businessDate: '2026-01-16' });
    expect(otherDate).toBeNull();
  });
});

describe('wms: warehouse units and labels', () => {
  it('creates a unit, appends a scanned line, and tracks reprint copy numbers', async () => {
    const created = await createWarehouseUnit(pool, undefined, { organizationId, warehouseId, unitType: 'CARTON', actor: actor() });
    expect(created.code).toContain('CAR-');

    const productId = randomUUID();
    const line = await addWarehouseUnitLine(pool, undefined, { unitCode: created.code, productId, uom: 'PCS', qty: '3', actor: actor() });
    expect(line.lineId).toBeTruthy();

    const lines = await pool.query(`SELECT product_id, qty FROM wms.warehouse_unit_line WHERE unit_id = $1`, [created.id]);
    expect(lines.rows).toEqual([{ product_id: productId, qty: '3.000' }]);

    const firstPrint = await printLabel(pool, undefined, { subjectType: 'UNIT', subjectId: created.id, actor: actor() });
    expect(firstPrint.copyNumber).toBe(1);
    const secondPrint = await printLabel(pool, undefined, { subjectType: 'UNIT', subjectId: created.id, actor: actor() });
    expect(secondPrint.copyNumber).toBe(2);
  });

  it('rejects appending a line to an unknown unit code', async () => {
    await expect(addWarehouseUnitLine(pool, undefined, { unitCode: 'NO-SUCH-UNIT', productId: randomUUID(), uom: 'PCS', qty: '1', actor: actor() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('wms: getWarehouseDashboard', () => {
  it('aggregates task counts, short-today, and pending-review counts for one warehouse', async () => {
    const dashboardWarehouseId = randomUUID();
    const receivingCode = code('DRECV');
    const binCode = code('DBIN');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: dashboardWarehouseId, code: receivingCode, type: 'RECEIVING', actor: actor() });
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: dashboardWarehouseId, code: binCode, type: 'BIN', actor: actor() });
    const productId = randomUUID();

    const received = await receiveGoods(pool, undefined, {
      organizationId, warehouseId: dashboardWarehouseId, locationCode: receivingCode, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(),
      lines: [{ productId, uom: 'KARTON', qty: '10' }], actor: actor(),
    });
    // One RECEIVE task born COMPLETED, one PUTAWAY task born CREATED.
    await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: binCode, qtyConfirmed: '6', actor: actor() });
    // qtyConfirmed (6) < qtyExpected (10) -> COMPLETED_SHORT, counted in shortToday.

    await submitCycleCount(pool, undefined, { organizationId, warehouseId: dashboardWarehouseId, locationCode: binCode, productId, uom: 'KARTON', countedQty: '999', actor: actor() });

    const dashboard = await getWarehouseDashboard(pool, { warehouseId: dashboardWarehouseId });
    expect(dashboard.taskCounts).toEqual(expect.arrayContaining([
      { type: 'RECEIVE', status: 'COMPLETED', count: 1 },
      { type: 'PUTAWAY', status: 'COMPLETED_SHORT', count: 1 },
      { type: 'COUNT', status: 'COMPLETED', count: 1 },
    ]));
    expect(dashboard.shortToday).toBe(1);
    expect(dashboard.discrepanciesPendingReview).toBe(1);
    expect(dashboard.cycleCountsPendingReview).toBe(1);
  });
});

describe('wms: completePacking + stagePackage + loadPackage', () => {
  it('walks a picked fulfillment reference through pack -> stage -> load', async () => {
    const receiving = await registerReceivingLocation();
    const bin = await registerBinLocation();
    const stagingCode = code('LANE');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: stagingCode, type: 'STAGING', actor: actor() });
    const productId = randomUUID();
    const pickReferenceId = randomUUID();

    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor() });
    await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: bin.code, qtyConfirmed: '8', actor: actor() });
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId,
      lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    const allocation = await allocatePickTask(pool, undefined, { organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId, lines: [{ productId, uom: 'KARTON', qty: '8' }], actor: actor() });
    await confirmPickTask(pool, undefined, { taskId: allocation.taskIds[0]!, scannedLocationCode: bin.code, scannedProductId: productId, qtyConfirmed: '8', actor: actor() });

    // WMS-007: build one koli containing everything picked for this reference.
    const koli = await createWarehouseUnit(pool, undefined, { organizationId, warehouseId, unitType: 'PACKAGE', referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId, actor: actor() });
    await addWarehouseUnitLine(pool, undefined, { unitCode: koli.code, productId, uom: 'KARTON', qty: '8', actor: actor() });

    await expect(completePacking(pool, undefined, { organizationId, warehouseId, referenceType: 'WRONG_TYPE', referenceId: pickReferenceId, actor: actor() })).rejects.toMatchObject({ code: 'PACK_QTY_MISMATCH' });

    const packed = await completePacking(pool, undefined, { organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId, actor: actor() });
    expect(packed.packageCount).toBe(1);
    const unitStatus = await pool.query(`SELECT status FROM wms.warehouse_unit WHERE id = $1`, [koli.id]);
    expect(unitStatus.rows[0].status).toBe('CLOSED');

    // WMS-008: staging the only koli for this reference immediately completes the stage.
    const staged = await stagePackage(pool, undefined, { unitCode: koli.code, laneCode: stagingCode, actor: actor() });
    expect(staged.stageCompleted).toBe(true);

    // WMS-009: loading the only koli in that lane immediately completes the load.
    const loaded = await loadPackage(pool, undefined, { unitCode: koli.code, vehicleCode: 'B 1234 XY', actor: actor() });
    expect(loaded.loadCompleted).toBe(true);

    const finalUnit = await pool.query(`SELECT loaded_vehicle_code FROM wms.warehouse_unit WHERE id = $1`, [koli.id]);
    expect(finalUnit.rows[0].loaded_vehicle_code).toBe('B 1234 XY');

    await expect(loadPackage(pool, undefined, { unitCode: koli.code, vehicleCode: 'B 1234 XY', actor: actor() })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('rejects staging a koli before it is packed', async () => {
    const stagingCode = code('LANE');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId, code: stagingCode, type: 'STAGING', actor: actor() });
    const koli = await createWarehouseUnit(pool, undefined, { organizationId, warehouseId, unitType: 'PACKAGE', actor: actor() });
    await expect(stagePackage(pool, undefined, { unitCode: koli.code, laneCode: stagingCode, actor: actor() })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('rejects loading a koli before it is staged', async () => {
    const koli = await createWarehouseUnit(pool, undefined, { organizationId, warehouseId, unitType: 'PACKAGE', actor: actor() });
    await pool.query(`UPDATE wms.warehouse_unit SET status = 'CLOSED' WHERE id = $1`, [koli.id]);
    await expect(loadPackage(pool, undefined, { unitCode: koli.code, vehicleCode: 'B 1234 XY', actor: actor() })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});

describe('wms: syncOfflineConfirmations', () => {
  it('replays a queued pick confirmation with source OFFLINE, is idempotent on resubmit, and reports a scan mismatch as NEEDS_REVIEW', async () => {
    const receiving = await registerReceivingLocation();
    const bin = await registerBinLocation();
    const productId = randomUUID();
    const pickReferenceId = randomUUID();

    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId, locationCode: receiving.code, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId, uom: 'KARTON', qty: '4' }], actor: actor() });
    await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: bin.code, qtyConfirmed: '4', actor: actor() });
    await reserveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId,
      lines: [{ productId, uom: 'KARTON', qty: '4' }], actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    const allocation = await allocatePickTask(pool, undefined, { organizationId, warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId: pickReferenceId, lines: [{ productId, uom: 'KARTON', qty: '4' }], actor: actor() });
    const taskId = allocation.taskIds[0]!;

    const actorForSync = actor();
    const synced = await syncOfflineConfirmations(pool, {
      actor: actorForSync,
      confirmations: [{ clientKey: randomUUID(), kind: 'PICK', taskId, scannedLocationCode: bin.code, scannedProductId: productId, qtyConfirmed: '4' }],
    });
    expect(synced.status).toBe('APPLIED');
    expect(synced.results[0]).toMatchObject({ outcome: 'SAVED' });

    const auditEntry = await pool.query(`SELECT source FROM audit.audit_entry WHERE entity_id = $1 AND action = 'PICK_CONFIRMED'`, [taskId]);
    expect(auditEntry.rows[0].source).toBe('OFFLINE');

    // Resubmitting the same queued confirmation (device retried after a partial network failure) is a no-op.
    const resynced = await syncOfflineConfirmations(pool, {
      actor: actorForSync,
      confirmations: [{ clientKey: randomUUID(), kind: 'PICK', taskId, scannedLocationCode: bin.code, scannedProductId: productId, qtyConfirmed: '4' }],
    });
    expect(resynced.results[0]).toMatchObject({ outcome: 'SAVED' });

    // A different task confirmed with a scan that no longer matches (e.g. someone else already
    // picked it differently) surfaces as NEEDS_REVIEW rather than aborting the whole batch.
    const mismatched = await syncOfflineConfirmations(pool, {
      actor: actorForSync,
      confirmations: [{ clientKey: randomUUID(), kind: 'PICK', taskId: randomUUID(), scannedLocationCode: bin.code, scannedProductId: productId, qtyConfirmed: '1' }],
    });
    expect(mismatched.status).toBe('APPLIED_WITH_CONFLICTS');
    expect(mismatched.results[0]).toMatchObject({ outcome: 'NEEDS_REVIEW', reason: 'NOT_FOUND' });
  });
});

describe('wms: operator presence', () => {
  it('reports a recently-heartbeated operator as online and an old one as offline', async () => {
    const presenceWarehouseId = randomUUID();
    const onlineUserId = randomUUID();
    const staleUserId = randomUUID();

    await heartbeatOperatorSession(pool, { organizationId, warehouseId: presenceWarehouseId, userId: onlineUserId });
    await heartbeatOperatorSession(pool, { organizationId, warehouseId: presenceWarehouseId, userId: staleUserId });
    await pool.query(`UPDATE wms.operator_session SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1`, [staleUserId]);

    const operators = await getActiveOperators(pool, { warehouseId: presenceWarehouseId, activeWithinMinutes: 5 });
    expect(operators).toHaveLength(2);
    expect(operators.find((operator) => operator.userId === onlineUserId)?.online).toBe(true);
    expect(operators.find((operator) => operator.userId === staleUserId)?.online).toBe(false);
  });

  it('tracks the operator current task from a heartbeat', async () => {
    const presenceWarehouseId = randomUUID();
    const userId = randomUUID();
    const receivingCode = code('PRECV');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: presenceWarehouseId, code: receivingCode, type: 'RECEIVING', actor: actor() });
    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId: presenceWarehouseId, locationCode: receivingCode, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId: randomUUID(), uom: 'KARTON', qty: '1' }], actor: actor() });

    await heartbeatOperatorSession(pool, { organizationId, warehouseId: presenceWarehouseId, userId, currentTaskId: received.putawayTaskIds[0] });
    const operators = await getActiveOperators(pool, { warehouseId: presenceWarehouseId });
    expect(operators[0]).toMatchObject({ userId, currentTaskType: 'PUTAWAY' });
  });
});

describe('wms: exception queue', () => {
  it('logs, assigns, and resolves an exception, and is idempotent against double-resolve', async () => {
    const exceptionWarehouseId = randomUUID();
    const logged = await logException(pool, {
      organizationId, warehouseId: exceptionWarehouseId, exceptionType: 'SCAN_MISMATCH',
      description: 'Barcode yang discan tidak sesuai dengan SKU pada tugas picking.',
    });
    expect(logged.id).toBeTruthy();

    const openQueue = await getExceptionQueue(pool, { warehouseId: exceptionWarehouseId, status: 'OPEN' });
    expect(openQueue).toHaveLength(1);
    expect(openQueue[0]).toMatchObject({ id: logged.id, exceptionType: 'SCAN_MISMATCH', status: 'OPEN' });

    const supervisorId = randomUUID();
    await assignException(pool, { id: logged.id, assignedTo: supervisorId });
    const inProgressQueue = await getExceptionQueue(pool, { warehouseId: exceptionWarehouseId, status: 'IN_PROGRESS' });
    expect(inProgressQueue[0]).toMatchObject({ id: logged.id, assignedTo: supervisorId });

    await resolveException(pool, { id: logged.id });
    const resolvedQueue = await getExceptionQueue(pool, { warehouseId: exceptionWarehouseId, status: 'RESOLVED' });
    expect(resolvedQueue).toHaveLength(1);

    await expect(resolveException(pool, { id: logged.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects assigning or resolving an unknown exception id', async () => {
    await expect(assignException(pool, { id: randomUUID(), assignedTo: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveException(pool, { id: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('wms: getLocationUtilization', () => {
  it('computes utilization only for locations with a recorded capacity', async () => {
    const utilizationWarehouseId = randomUUID();
    const tracked = await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: utilizationWarehouseId, code: code('CAPBIN'), type: 'BIN', capacityQty: '100', actor: actor() });
    const untracked = await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: utilizationWarehouseId, code: code('NOCAPBIN'), type: 'BIN', actor: actor() });
    await pool.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, 'KARTON', 40, 0, 1)`,
      [randomUUID(), organizationId, utilizationWarehouseId, tracked.id, randomUUID()],
    );

    const utilization = await getLocationUtilization(pool, { warehouseId: utilizationWarehouseId });
    const trackedRow = utilization.find((row) => row.locationId === tracked.id);
    const untrackedRow = utilization.find((row) => row.locationId === untracked.id);
    expect(trackedRow).toMatchObject({ qtyOnHand: '40.000', capacityQty: '100.000', utilizationPct: 0.4 });
    expect(untrackedRow).toMatchObject({ qtyOnHand: '0.000', capacityQty: null, utilizationPct: null });
  });
});

describe('wms: getWarehouseReport', () => {
  it('computes real KPIs and detail rows from completed tasks', async () => {
    const reportWarehouseId = randomUUID();
    const receivingCode = code('RREPT');
    const binCode = code('BREPT');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: reportWarehouseId, code: receivingCode, type: 'RECEIVING', actor: actor() });
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: reportWarehouseId, code: binCode, type: 'BIN', actor: actor() });
    const productId = randomUUID();

    const received = await receiveGoods(pool, undefined, { organizationId, warehouseId: reportWarehouseId, locationCode: receivingCode, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId, uom: 'KARTON', qty: '10' }], actor: actor() });
    await putawayStock(pool, undefined, { taskId: received.putawayTaskIds[0]!, toLocationCode: binCode, qtyConfirmed: '10', actor: actor() });

    const today = new Date().toISOString().slice(0, 10);
    const report = await getWarehouseReport(pool, { warehouseId: reportWarehouseId, fromDate: today, toDate: today });

    expect(report.kpis.putawaySlaPct).toBe(1);
    expect(report.kpis.receivingTurnaroundAvgMinutes).not.toBeNull();
    expect(report.taskTypeComposition).toEqual(expect.arrayContaining([
      { type: 'RECEIVE', count: 1 }, { type: 'PUTAWAY', count: 1 },
    ]));
    expect(report.detailRows.length).toBeGreaterThanOrEqual(2);
    expect(report.detailRows.some((row) => row.locationCode === receivingCode)).toBe(true);
  });
});

describe('wms: listWarehouseTasks', () => {
  it('lists and filters tasks for one warehouse, most recently updated first', async () => {
    const listWarehouseId = randomUUID();
    const receivingCode = code('LRECV');
    await registerWarehouseLocation(pool, undefined, { organizationId, warehouseId: listWarehouseId, code: receivingCode, type: 'RECEIVING', actor: actor() });
    await receiveGoods(pool, undefined, { organizationId, warehouseId: listWarehouseId, locationCode: receivingCode, referenceType: 'WMS_RECEIVING', referenceId: randomUUID(), lines: [{ productId: randomUUID(), uom: 'KARTON', qty: '5' }], actor: actor() });

    const all = await listWarehouseTasks(pool, { warehouseId: listWarehouseId });
    expect(all).toHaveLength(2); // one RECEIVE (completed) + one PUTAWAY (created)

    const onlyReceive = await listWarehouseTasks(pool, { warehouseId: listWarehouseId, type: 'RECEIVE' });
    expect(onlyReceive).toHaveLength(1);
    expect(onlyReceive[0]).toMatchObject({ type: 'RECEIVE', status: 'COMPLETED', locationCode: receivingCode });

    const onlyCreated = await listWarehouseTasks(pool, { warehouseId: listWarehouseId, status: 'CREATED' });
    expect(onlyCreated).toHaveLength(1);
    expect(onlyCreated[0]).toMatchObject({ type: 'PUTAWAY', status: 'CREATED' });
  });
});
