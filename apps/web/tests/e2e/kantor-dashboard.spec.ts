import type { KantorDashboard } from '../../lib/kantor/dashboard';
import { expect, test, type Page } from '@playwright/test';
import { mockShell, snapshot } from './shell.fixture';

/**
 * The daily dashboard's two profit tiles, against a stand-in for the BFF's composed answer.
 *
 * The tile is a permission-aware control surface, so both branches matter and neither is the
 * interesting one on its own: a viewer who may see profit must see Finance's figures unchanged, and a
 * viewer who may not must find nothing there at all (MVP-OD-10, ADR-0015). A dashboard that hid the
 * tile from everyone would pass only the second.
 *
 * The composition itself — which read is issued, what happens when Finance is down, and why the branch
 * is never chosen here — is in tests/kantor-dashboard.test.ts.
 */
const BUSINESS_DATE = '2026-10-01';
function dashboardOf(grossProfit: KantorDashboard['grossProfit']): KantorDashboard {
  return {
    businessDate: BUSINESS_DATE,
    sales: { state: 'OK', data: { salesTotal: '236000.00', saleCount: 2, undepositedCash: '236000.00', undepositedPaymentCount: 1 } },
    lowStock: { state: 'OK', data: { threshold: '10', total: 0, items: [] } },
    stockValue: { state: 'OK', data: { totalValue: '40732000.00', unvaluedCount: 0, balanceCount: 20 } },
    grossProfit,
  };
}

const salesSummary = { businessDate: BUSINESS_DATE, salesTotal: '236000.00', saleCount: 2, undepositedCash: '236000.00', undepositedPaymentCount: 1 };

/** The dashboard is composed on the server, so the browser is given the finished answer. */
async function mockDashboard(page: Page, grossProfit: KantorDashboard['grossProfit']): Promise<void> {
  await page.route('**/api/kantor/dashboard', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(dashboardOf(grossProfit)),
  }));
  await page.route('**/api/bff/core/pos/reports/summary*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(salesSummary),
  }));
  await page.route('**/api/bff/core/me/permissions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ userId: '0199a000-0000-7000-8000-0000000000a1', grants: [] }),
  }));
}

const card = (page: Page, label: string) => page.locator('.pss-kpi-card').filter({ hasText: label });

test('a viewer with the Control Station permission sees Finance’s figures and its margin', async ({ page }) => {
  await mockDashboard(page, { state: 'OK', data: { today: '46000.00', monthToDate: '120000.00', todayMarginPercent: '19.49' } });
  await mockShell(page);
  await page.goto('/kantor', { waitUntil: 'domcontentloaded' });

  // The day's figure and the month's, exactly as Finance published them — no rounding, no
  // recalculated percentage on this side of the wire.
  await expect(card(page, 'Laba kotor hari ini')).toContainText('Rp 46.000', { timeout: 20_000 });
  await expect(card(page, 'Laba kotor hari ini')).toContainText('margin 19,49%');
  await expect(card(page, 'Laba kotor bulan ini')).toContainText('Rp 120.000');
  await snapshot(page, 'kantor-dashboard-gross-profit');
});

test('a margin Finance withheld reads as absent, not as a zero', async ({ page }) => {
  // `grossMarginPercent: null` means "no sales to take a margin of". Rendering 0,00% would state the
  // opposite — that the goods sold at no margin — which is a different business fact entirely.
  await mockDashboard(page, { state: 'OK', data: { today: '0.00', monthToDate: '0.00', todayMarginPercent: null } });
  await mockShell(page);
  await page.goto('/kantor', { waitUntil: 'domcontentloaded' });

  await expect(card(page, 'Laba kotor hari ini')).toContainText('Rp 0', { timeout: 20_000 });
  await expect(card(page, 'Laba kotor hari ini')).not.toContainText('margin');
});

test('a viewer without the permission finds no profit tile and no error about it', async ({ page }) => {
  await mockDashboard(page, { state: 'HIDDEN' });
  await mockShell(page);
  await page.goto('/kantor', { waitUntil: 'domcontentloaded' });

  await expect(card(page, 'Penjualan hari ini')).toContainText('Rp 236.000', { timeout: 20_000 });
  await expect(card(page, 'Laba kotor hari ini')).toHaveCount(0);
  await expect(card(page, 'Laba kotor bulan ini')).toHaveCount(0);
  // And nothing on the page explains a missing tile: an absent permission is not an incident.
  await expect(page.locator('body')).not.toContainText('tidak punya hak');
});

test('a Finance service that is down says so in words rather than showing Rp 0', async ({ page }) => {
  await mockDashboard(page, { state: 'UNAVAILABLE', problemCode: 'DEPENDENCY_UNAVAILABLE', reason: 'laba kotor sedang tidak dapat dimuat. Muat ulang sebentar lagi.' });
  await mockShell(page);
  await page.goto('/kantor', { waitUntil: 'domcontentloaded' });

  // The tile is present and says what is wrong; the value stays a dash, so nothing reads as "no
  // profit" (MVP-OD-4: the margin is Finance's arithmetic, not a fallback here).
  await expect(card(page, 'Laba kotor hari ini')).toBeVisible({ timeout: 20_000 });
  await expect(card(page, 'Laba kotor hari ini')).not.toContainText('Rp 0');
  await expect(card(page, 'Laba kotor hari ini')).toContainText('Muat ulang');
});