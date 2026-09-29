import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activatePriceList } from '../src/application/activate-price-list';
import { resolvePrice } from '../src/application/resolve-price';

const databaseName = `pss_commercial_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  const migration = await readFile(new URL('../infrastructure/database/migrations/0001_commercial.sql', import.meta.url), 'utf8');
  await pool.query(migration);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('COM-001/COM-002 commercial price list', () => {
  it('throws PRICE_NOT_FOUND when no price list is active for the scope', async () => {
    const organizationId = randomUUID();
    await expect(resolvePrice(pool, {
      organizationId,
      productId: randomUUID(),
      uom: 'CTN',
      priceListScope: 'RETAIL',
    })).rejects.toMatchObject({ code: 'PRICE_NOT_FOUND' });
  });

  it('resolves the unit price from the price list activated for the scope', async () => {
    const organizationId = randomUUID();
    const productId = randomUUID();
    const { priceListId, version } = await activatePriceList(pool, {
      organizationId,
      scope: 'RETAIL',
      validFrom: '2026-01-01',
      items: [{ productId, uom: 'CTN', unitPrice: '15000.50' }],
    });

    const resolved = await resolvePrice(pool, {
      organizationId,
      productId,
      uom: 'CTN',
      priceListScope: 'RETAIL',
    });

    expect(resolved).toEqual({ unitPrice: '15000.50', priceListId, priceListVersion: version });
    expect(typeof resolved.unitPrice).toBe('string');
  });

  it('supersedes the previously active price list when a new one is activated for the same scope', async () => {
    const organizationId = randomUUID();
    const productId = randomUUID();

    const first = await activatePriceList(pool, {
      organizationId,
      scope: 'RETAIL',
      validFrom: '2026-01-01',
      items: [{ productId, uom: 'CTN', unitPrice: '10000.00' }],
    });

    const second = await activatePriceList(pool, {
      organizationId,
      scope: 'RETAIL',
      validFrom: '2026-02-01',
      items: [{ productId, uom: 'CTN', unitPrice: '12500.00' }],
    });

    const firstListStatus = await pool.query(
      `SELECT status FROM core.price_list WHERE id = $1`,
      [first.priceListId],
    );
    expect(firstListStatus.rows[0].status).toBe('EXPIRED');

    const resolved = await resolvePrice(pool, {
      organizationId,
      productId,
      uom: 'CTN',
      priceListScope: 'RETAIL',
    });
    expect(resolved.priceListId).toBe(second.priceListId);
    expect(resolved.unitPrice).toBe('12500.00');

    const activeCount = await pool.query(
      `SELECT count(*)::int AS count FROM core.price_list
       WHERE organization_id = $1 AND scope = $2 AND status = 'ACTIVE'`,
      [organizationId, 'RETAIL'],
    );
    expect(Number(activeCount.rows[0].count)).toBe(1);
  });

  it('rejects an invalid unit price before inserting anything', async () => {
    const organizationId = randomUUID();
    await expect(activatePriceList(pool, {
      organizationId,
      scope: 'GROSIR',
      validFrom: '2026-01-01',
      items: [{ productId: randomUUID(), uom: 'CTN', unitPrice: '12.999' }],
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const count = await pool.query(
      `SELECT count(*)::int AS count FROM core.price_list WHERE organization_id = $1 AND scope = $2`,
      [organizationId, 'GROSIR'],
    );
    expect(Number(count.rows[0].count)).toBe(0);
  });
});
