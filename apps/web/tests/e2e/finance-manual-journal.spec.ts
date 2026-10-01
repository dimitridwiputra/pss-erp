import Decimal from 'decimal.js';
import { expect, test, type Page } from '@playwright/test';

/**
 * Local governed Finance journey. Prepare two distinct local identities with FINANCE_MAKER
 * and FINANCE_APPROVER assignments, and recent OTP authentication for the approver.
 * The Finance API, worker, PostgreSQL and Keycloak must be running with the demo COA seed.
 */
const maker = { username: process.env.PSS_FINANCE_E2E_MAKER_USER,
  password: process.env.PSS_FINANCE_E2E_MAKER_PASSWORD };
const approver = { username: process.env.PSS_FINANCE_E2E_APPROVER_USER,
  password: process.env.PSS_FINANCE_E2E_APPROVER_PASSWORD,
  otp: process.env.PSS_FINANCE_E2E_APPROVER_OTP };
const amount = '7823.17';

async function signIn(page: Page, credentials: {
  username: string | undefined; password: string | undefined; otp?: string | undefined;
}) {
  await page.goto('/masuk');
  await page.getByRole('button', { name: /Masuk dengan akun PSS/ }).click();
  await page.getByRole('textbox', { name: /username|email/i }).fill(credentials.username!);
  await page.locator('input[type=password]').fill(credentials.password!);
  await page.getByRole('button', { name: /sign in/i }).click();
  const otp = page.locator('input[name=otp]');
  if (credentials.otp && await otp.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await otp.fill(credentials.otp);
    await page.getByRole('button', { name: /sign in|masuk/i }).click();
  }
  await expect(page).toHaveURL(/\/beranda$/, { timeout: 20_000 });
}

async function expenseBalance(page: Page): Promise<Decimal> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  const response = await page.request.get(`/api/bff/finance/finance/trial-balance?through=${today}`);
  expect(response.ok()).toBe(true);
  const result = await response.json() as { lines: Array<{ code: string; debit: string }> };
  return new Decimal(result.lines.find((line) => line.code === '6-9000')?.debit ?? '0.00');
}

test('Finance Maker submits a journal, another approver decides, and Neraca Saldo reflects it', async ({ browser }) => {
  test.skip(!maker.username || !maker.password || !approver.username || !approver.password || !approver.otp,
    'Set two Finance test identities and an approver OTP before running this local governed path.');
  const makerContext = await browser.newContext();
  const approverContext = await browser.newContext();
  try {
    const makerPage = await makerContext.newPage();
    const approverPage = await approverContext.newPage();
    await signIn(approverPage, approver);
    await signIn(makerPage, maker);
    const before = await expenseBalance(makerPage);
    await makerPage.goto('/keuangan/jurnal-manual');
    await makerPage.getByLabel('Tujuan dan alasan').fill('Uji alur jurnal manual maker dan checker');
    const rows = makerPage.locator('.finance-form-row');
    await rows.nth(0).getByLabel('Akun').selectOption('6-9000');
    await rows.nth(0).getByLabel('Debit').fill(amount);
    await rows.nth(1).getByLabel('Akun').selectOption('1-1100');
    await rows.nth(1).getByLabel('Kredit').fill(amount);
    await expect(makerPage.getByRole('status').filter({ hasText: 'Seimbang' })).toBeVisible();
    await makerPage.getByRole('button', { name: 'Simpan draf' }).click();
    const draftLink = makerPage.getByRole('link', { name: 'Tinjau draf jurnal' });
    await expect(draftLink).toBeVisible();
    const draftId = (await draftLink.getAttribute('href'))?.split('/').pop();
    expect(draftId).toBeTruthy();
    const journalResponse = await makerPage.request.get(`/api/bff/finance/finance/journals/${draftId}`);
    expect(journalResponse.ok()).toBe(true);
    const journal = await journalResponse.json() as { number: string };
    await makerPage.getByRole('button', { name: 'Ajukan persetujuan' }).click();
    await expect(makerPage.getByRole('status').filter({ hasText: 'menunggu persetujuan' })).toBeVisible();

    await expect.poll(async () => {
      await approverPage.goto('/persetujuan');
      return approverPage.getByTestId('approval-card').filter({ hasText: `Jurnal ${journal.number}` }).count();
    }, { timeout: 20_000 }).toBeGreaterThan(0);
    const card = approverPage.getByTestId('approval-card').filter({ hasText: `Jurnal ${journal.number}` });
    await card.getByLabel('Alasan keputusan').fill('Jurnal seimbang dan bukti telah diperiksa');
    await card.getByRole('button', { name: 'Setujui' }).click();
    await expect.poll(async () => (await expenseBalance(makerPage)).minus(before).toFixed(2),
      { timeout: 20_000 }).toBe(amount);
    await makerPage.goto('/keuangan/neraca-saldo');
    await expect(makerPage.getByRole('heading', { name: 'Neraca Saldo' })).toBeVisible();
    await expect(makerPage.locator('.finance-table')).toContainText('6-9000');
  } finally {
    await makerContext.close();
    await approverContext.close();
  }
});
