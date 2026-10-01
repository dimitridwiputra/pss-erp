import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { activatePriceList } from '../src/application/activate-price-list';
import { activateDraftPriceList } from '../src/application/activate-draft-price-list';
import { createDraftPriceList } from '../src/application/create-draft-price-list';
import { listPriceListItems } from '../src/application/list-price-list-items';
import { setPriceListItem } from '../src/application/set-price-list-item';
import { resolvePrice } from '../src/application/resolve-price';
import { applyAuditMigrations, applyDomainMigrations } from '../../../scripts/apply-migrations.mjs';

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
  // Every command here audits through @pss/audit's transaction, so its schema must exist first.
  await applyAuditMigrations(pool);
  // This domain's ordered migration list, not a named file, so a migration added later runs here
  // rather than being silently skipped.
  await applyDomainMigrations((sql) => pool.query(sql), 'commercial');
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
    const { priceListId, version } = await activatePriceList(pool, undefined, {
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

    const first = await activatePriceList(pool, undefined, {
      organizationId,
      scope: 'RETAIL',
      validFrom: '2026-01-01',
      items: [{ productId, uom: 'CTN', unitPrice: '10000.00' }],
    });

    const second = await activatePriceList(pool, undefined, {
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
    await expect(activatePriceList(pool, undefined, {
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

  it('writes one PRICE_LIST_ACTIVATED audit entry per activation', async () => {
    const organizationId = randomUUID();
    const priceListId = (await activatePriceList(pool, undefined, {
      organizationId, scope: 'AUDITED', validFrom: '2026-01-01',
      items: [{ productId: randomUUID(), uom: 'CTN', unitPrice: '1000.00' }],
    })).priceListId;

    const audit = await pool.query(
      `SELECT action FROM audit.audit_entry
       WHERE entity_domain = 'commercial' AND entity_id = $1 AND action = 'PRICE_LIST_ACTIVATED'`,
      [priceListId],
    );
    expect(audit.rows).toHaveLength(1);
  });
});

describe('COM-001 a price change is a new version, never an edit in place', () => {
  const meta = () => ({
    actor: { userId: randomUUID(), roles: ['COMMERCIAL_ADMIN'] },
    requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const,
  });

  it('copies the active list into a DRAFT, edits one price there, and activates the new version', async () => {
    const organizationId = randomUUID();
    const productId = randomUUID();
    const otherProductId = randomUUID();
    const live = await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01',
      items: [
        { productId, uom: 'KARTON', unitPrice: '118000.00' },
        { productId: otherProductId, uom: 'KARTON', unitPrice: '48000.00' },
      ],
      ...meta(),
    });

    const draft = await createDraftPriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-11-01', copyFromPriceListId: live.priceListId, ...meta(),
    });
    expect(draft.version).toBe(live.version + 1);
    expect(draft.itemCount).toBe(2);

    await setPriceListItem(pool, undefined, {
      organizationId, priceListId: draft.priceListId, productId, uom: 'KARTON', unitPrice: '125000.00', ...meta(),
    });

    // The live list is untouched while the draft is edited, so orders in the meantime keep the old price.
    expect((await resolvePrice(pool, { organizationId, productId, uom: 'KARTON', priceListScope: 'KONTER' })).unitPrice)
      .toBe('118000.00');

    const activated = await activateDraftPriceList(pool, undefined, {
      organizationId, priceListId: draft.priceListId, ...meta(),
    });
    expect(activated.version).toBe(draft.version);

    // The new version is live for the changed price, and the untouched price came across with the copy.
    expect((await resolvePrice(pool, { organizationId, productId, uom: 'KARTON', priceListScope: 'KONTER' })).unitPrice)
      .toBe('125000.00');
    expect((await resolvePrice(pool, { organizationId, productId: otherProductId, uom: 'KARTON', priceListScope: 'KONTER' })).unitPrice)
      .toBe('48000.00');

    const statuses = await pool.query(
      `SELECT status FROM core.price_list WHERE organization_id = $1 AND scope = 'KONTER' ORDER BY version`,
      [organizationId],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(['EXPIRED', 'ACTIVE']);
  });

  it('refuses to edit a list that is no longer a DRAFT (COM-001.NC01)', async () => {
    const organizationId = randomUUID();
    const productId = randomUUID();
    const live = await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01',
      items: [{ productId, uom: 'KARTON', unitPrice: '118000.00' }], ...meta(),
    });

    const attempt = await setPriceListItem(pool, undefined, {
      organizationId, priceListId: live.priceListId, productId, uom: 'KARTON', unitPrice: '1.00', ...meta(),
    }).catch((error) => error);

    expect(attempt).toBeInstanceOf(DomainError);
    expect((attempt as DomainError).code).toBe('INVALID_STATE_TRANSITION');
    expect((attempt as DomainError).fieldErrors?.[0]?.message)
      .toBe('Harga yang sudah aktif tidak bisa diubah. Buat versi daftar harga baru.');
  });

  it('refuses to activate a draft with no prices, and a list twice', async () => {
    const organizationId = randomUUID();
    const empty = await createDraftPriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01', ...meta(),
    });

    const emptyAttempt = await activateDraftPriceList(pool, undefined, {
      organizationId, priceListId: empty.priceListId, ...meta(),
    }).catch((error) => error);
    expect((emptyAttempt as DomainError).code).toBe('VALIDATION_FAILED');

    const filled = await createDraftPriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01', ...meta(),
    });
    await setPriceListItem(pool, undefined, {
      organizationId, priceListId: filled.priceListId, productId: randomUUID(), uom: 'PCS', unitPrice: '5000.00', ...meta(),
    });
    await activateDraftPriceList(pool, undefined, { organizationId, priceListId: filled.priceListId, ...meta() });

    const again = await activateDraftPriceList(pool, undefined, {
      organizationId, priceListId: filled.priceListId, ...meta(),
    }).catch((error) => error);
    expect((again as DomainError).code).toBe('INVALID_STATE_TRANSITION');
  });

  it('reports a price list in another organization as NOT_FOUND', async () => {
    const organizationId = randomUUID();
    const live = await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01',
      items: [{ productId: randomUUID(), uom: 'PCS', unitPrice: '1000.00' }], ...meta(),
    });
    const elsewhere = randomUUID();
    const rejected = async (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await rejected(createDraftPriceList(pool, undefined, {
      organizationId: elsewhere, scope: 'KONTER', validFrom: '2026-10-01', copyFromPriceListId: live.priceListId, ...meta(),
    }));
    await rejected(setPriceListItem(pool, undefined, {
      organizationId: elsewhere, priceListId: live.priceListId, productId: randomUUID(), uom: 'PCS', unitPrice: '1.00', ...meta(),
    }));
    await rejected(listPriceListItems(pool, undefined, { organizationId: elsewhere, priceListId: live.priceListId }));
    await rejected(activateDraftPriceList(pool, undefined, {
      organizationId: elsewhere, priceListId: live.priceListId, ...meta(),
    }));
  });

  it('leaves an audit entry when the same price is set twice on a draft (ADR-0013 §4b)', async () => {
    const organizationId = randomUUID();
    const productId = randomUUID();
    const draft = await createDraftPriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01', ...meta(),
    });
    const first = await setPriceListItem(pool, undefined, {
      organizationId, priceListId: draft.priceListId, productId, uom: 'PCS', unitPrice: '7000.00', ...meta(),
    });
    const second = await setPriceListItem(pool, undefined, {
      organizationId, priceListId: draft.priceListId, productId, uom: 'PCS', unitPrice: '7000.00', ...meta(),
    });

    // Same item, so the no-op path reuses the stored row's id rather than inserting a second one.
    expect(second.priceListItemId).toBe(first.priceListItemId);
    const audit = await pool.query(
      `SELECT changes->0->>'before' AS before, changes->0->>'after' AS after FROM audit.audit_entry
       WHERE action = 'PRICE_LIST_ITEM_SET' AND entity_id = $1 ORDER BY occurred_at`,
      [first.priceListItemId],
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0].before).toBeNull();
    expect(audit.rows[0].after).toBe('7000.00');
    // The second attempt changed nothing, and says so rather than passing through untraced.
    expect(audit.rows[1].before).toBe('7000.00');
    expect(audit.rows[1].after).toBe('7000.00');
  });
});

describe('COM-001 listPriceListItems', () => {
  const meta = () => ({
    actor: { userId: randomUUID(), roles: ['COMMERCIAL_ADMIN'] },
    requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const,
  });

  it('pages items, reports the total, and carries the list status and version', async () => {
    const organizationId = randomUUID();
    const products = Array.from({ length: 5 }, () => randomUUID());
    const live = await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01',
      items: products.map((productId, index) => ({ productId, uom: 'PCS', unitPrice: `${1000 + index}.00` })),
      ...meta(),
    });

    const page = await listPriceListItems(pool, undefined, { organizationId, priceListId: live.priceListId, pageSize: 2 });
    expect(page.status).toBe('ACTIVE');
    expect(page.version).toBe(live.version);
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it('filters by product and sorts only by an allow-listed field', async () => {
    const organizationId = randomUUID();
    const target = randomUUID();
    const live = await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-10-01',
      items: [
        { productId: target, uom: 'PCS', unitPrice: '9000.00' },
        { productId: randomUUID(), uom: 'PCS', unitPrice: '1000.00' },
      ],
      ...meta(),
    });

    const filtered = await listPriceListItems(pool, undefined, { organizationId, priceListId: live.priceListId, productId: target });
    expect(filtered.items.map((item) => item.productId)).toEqual([target]);

    const byPrice = await listPriceListItems(pool, undefined, { organizationId, priceListId: live.priceListId, sort: 'unitPrice' });
    expect(byPrice.items[0]?.unitPrice).toBe('9000.00');

    const attempt = await listPriceListItems(pool, undefined, {
      organizationId, priceListId: live.priceListId, sort: 'created_at' as 'unitPrice',
    }).catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
  });
});

