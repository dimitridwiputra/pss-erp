import { expect, test, type Page } from '@playwright/test';
import { mockShell, snapshot } from './shell.fixture';

/**
 * Barang's PPN treatment against a stand-in for the BFF, as in kantor-counter.spec.ts.
 *
 * The case exists because the field is a tax decision. A product with no `taxCode` is refused at the
 * counter for a PPN customer (TAX-001, MVP-OD-3), so the screen has to make the operator choose
 * rather than default, and it has to say plainly when a product has none. The routes themselves are
 * covered end to end by apps/api/tests/backoffice.integration.test.ts.
 */
const productId = '0199a000-0000-7000-8000-0000000000d1';
const emptyList = { items: [], page: 1, pageSize: 25, total: 0, hasMore: false };

/**
 * The grants `admin.demo` holds (MVP_PLAN §7). The Barang screen hides its write affordances from a
 * viewer without `master_data.product.manage`, so the permission-aware UI needs the real answer rather
 * than a shell that merely has the link.
 */
async function mockGrants(page: Page) {
  await page.route('**/api/bff/core/me/permissions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      userId: '0199a000-0000-7000-8000-0000000000a1',
      grants: [
        { permission: 'master_data.product.manage', scopeType: 'ORGANIZATION', scopeId: null },
        { permission: 'commercial.price_list.manage', scopeType: 'ORGANIZATION', scopeId: null },
        { permission: 'inventory.stock_card.view', scopeType: 'WAREHOUSE', scopeId: '0199a000-0000-7000-8000-0000000000a2' },
      ],
    }),
  }));
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    productId,
    sku: 'BRG-PPN-1',
    name: 'Teh Kotak 350ml',
    baseUom: 'BTL',
    orderCapture: 'PSS',
    status: 'ACTIVE',
    taxCode: null,
    version: 1,
    createdAt: '2026-10-01T02:00:00.000Z',
    units: [{ uom: 'BTL', isBase: true, conversionFactor: '1.000000', barcode: null }],
    ...overrides,
  };
}

async function json(page: Page, pattern: string, handler: (body: unknown) => { status?: number; body: unknown }) {
  await page.route(pattern, async (route) => {
    const result = handler(route.request().postDataJSON?.() ?? null);
    await route.fulfill({ status: result.status ?? 200, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
}

test('Barang makes the operator choose PPN, and says so when a product has none', async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  let updated: Record<string, unknown> | null = null;
  let detail = product();

  await json(page, '**/api/bff/core/master-data/products?*', () => ({ body: detail ? { ...emptyList, items: [detail], total: 1 } : emptyList }));
  await json(page, '**/api/bff/core/master-data/products', (body) => {
    created = body as Record<string, unknown>;
    detail = product({ ...created, productId, version: 1 });
    return { status: 201, body: detail };
  });
  await json(page, `**/api/bff/core/master-data/products/${productId}`, (body) => {
    if (body === null) return { body: detail };
    updated = body as Record<string, unknown>;
    detail = product({ ...detail, ...(body as object), version: detail.version + 1 });
    return { body: { productId, version: detail.version } };
  });

  await mockShell(page);
  await mockGrants(page);
  await page.goto('/kantor/barang');
  await page.getByRole('button', { name: 'Barang Baru' }).click();

  // Nothing is pre-selected: a default would be the system deciding a tax treatment, and the button
  // stays disabled until a person chooses one.
  const pajak = page.getByLabel('Pajak');
  await expect(pajak).toHaveValue('');
  const simpan = page.getByRole('button', { name: 'Simpan Barang' });
  await expect(simpan).toBeDisabled();

  await page.getByRole('textbox', { name: 'SKU' }).fill('BRG-PPN-1');
  await page.getByRole('textbox', { name: 'Nama barang' }).fill('Teh Kotak 350ml');
  await page.getByRole('combobox', { name: 'Pajak' }).selectOption('VAT_OUTPUT');
  await expect(page.getByText(/Barang ini dikenai PPN/)).toBeVisible();
  await expect(simpan).toBeEnabled();
  await simpan.click();

  // What the screen sends is the whole point: a chosen code goes out, and no other field invents one.
  expect(created).toMatchObject({ sku: 'BRG-PPN-1', taxCode: 'VAT_OUTPUT' });
  await snapshot(page, 'kantor-barang-created');

  // The product now says it is taxed, so a PPN sale is not refused at the counter.
  await page.getByRole('button', { name: 'Teh Kotak 350ml' }).click();
  await expect(page.getByRole('heading', { name: 'Teh Kotak 350ml' })).toBeVisible();
  const edit = page.getByLabel('Pajak');
  await expect(edit).toHaveValue('VAT_OUTPUT');
  await expect(page.getByText('Saat ini: Kena PPN.')).toBeVisible();

  await edit.selectOption('NON_VAT');
  await page.getByRole('button', { name: 'Simpan Perubahan' }).click();
  expect(updated).toMatchObject({ taxCode: 'NON_VAT', expectedVersion: 1 });
  await expect(page.getByRole('status')).toContainText('Perubahan barang tersimpan');
  await expect(edit).toHaveValue('NON_VAT');
});

test('a product with no PPN treatment warns that a PPN sale will be refused', async ({ page }) => {
  await json(page, '**/api/bff/core/master-data/products?*', () => ({
    body: { ...emptyList, items: [product()], total: 1 },
  }));
  await json(page, `**/api/bff/core/master-data/products/${productId}`, () => ({ body: product() }));

  await mockShell(page);
  await mockGrants(page);
  await page.goto('/kantor/barang');
  await page.getByRole('button', { name: 'Teh Kotak 350ml' }).click();

  const edit = page.getByLabel('Pajak');
  await expect(edit).toHaveValue('');
  // The consequence, not just the state: this is the sentence that stops an operator wondering why a
  // PPN sale was refused at the counter.
  await expect(page.getByText('Penjualan barang ini ke pelanggan kena PPN akan ditolak sampai pajaknya diatur.')).toBeVisible();
});