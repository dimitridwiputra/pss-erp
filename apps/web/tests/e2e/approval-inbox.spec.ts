import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  demoCredentials, markLocalApprovalDecided, removeLocalApproval, seedLocalApproval,
} from './experience-approvals.fixture';

/**
 * APR-002 browser coverage: the happy path, the unauthorised deep link, and the stale
 * decision. It needs the local Keycloak realm, the local Compose database, `@pss/api` on
 * 4000 and `@pss/web` on 3000, so it runs with `pnpm test:e2e:local` or with
 * `playwright.experience.config.ts`.
 *
 * The decision command requires a recent OTP claim for a BRANCH_MANAGER (AGENTS.md §15,
 * `requireRecentMfa`), which a password-only local sign-in cannot produce, so the suite
 * covers the decision through its exception path: a request another approver already
 * decided answers `STALE_DATA` before the MFA and SoD checks run.
 */
const SIGN_IN_TIMEOUT = 20_000;
const SEEDED_SUMMARY = 'Override kredit · Toko Makmur · Rp 15 jt';

let approvalId: string | null = null;
let skipReason: string | null = null;

async function signIn(page: Page) {
  const credentials = await demoCredentials();
  if (!credentials) throw new Error('Run pnpm dev:up to prepare the local demo account.');
  await page.goto('/masuk');
  await page.getByRole('button', { name: /Masuk dengan akun PSS/ }).click();
  await page.getByRole('textbox', { name: /username|email/i }).fill(credentials.username);
  await page.locator('input[type=password]').fill(credentials.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/beranda$/, { timeout: SIGN_IN_TIMEOUT });
}

/** Reads the approval id from the card the inbox offers, so the suite needs no id fixture. */
async function readSeededApprovalId(page: Page): Promise<string> {
  const card = page.getByTestId('approval-card').filter({ hasText: SEEDED_SUMMARY });
  await expect(card).toBeVisible();
  const href = await card.getByRole('link', { name: 'Lihat detail' }).getAttribute('href');
  const id = href?.split('/').pop();
  if (!id) throw new Error('The approval card has no deep link.');
  return id;
}

test.describe.serial('APR-002 kotak persetujuan', () => {
  test.beforeAll(async () => {
    // The suite needs the local Keycloak realm and the local Compose database. Without them
    // the reason is reported on every skipped test instead of failing a gate that never had
    // the preconditions (AGENTS.md §16, PRD TST.R06).
    if (!await demoCredentials()) {
      skipReason = 'The local Keycloak demo account is missing; run pnpm dev:up first.';
      return;
    }
    try {
      seedLocalApproval();
    } catch (error) {
      skipReason = `The local approval fixture is unavailable: ${error instanceof Error ? error.message : 'unknown error'}.`;
    }
  });

  test.afterAll(() => {
    if (approvalId) removeLocalApproval(approvalId);
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? '');
    await signIn(page);
  });

  test('APR-002.AC01 an approver sees only their own pending request, ready to decide', async ({ page }) => {
    await page.goto('/persetujuan');
    await expect(page.getByRole('heading', { name: 'Persetujuan', level: 1 })).toBeVisible();
    const card = page.getByTestId('approval-card').filter({ hasText: SEEDED_SUMMARY });
    // A labelled status, never a raw state (UX-002.NC01).
    await expect(card.getByText('Menunggu persetujuan Anda')).toBeVisible();
    await expect(card).toContainText('Rp');
    await expect(card).toContainText('Batas waktu');
    await expect(card.getByRole('button', { name: 'Setujui' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Tolak' })).toBeVisible();
    // Only the seeded request is listed: nothing outside the approver scope reaches the list.
    await expect(page.getByTestId('approval-card')).toHaveCount(1);
    approvalId = await readSeededApprovalId(page);
  });

  test('APR-002 deep link opens the request the approver may act on', async ({ page }) => {
    test.skip(approvalId === null, 'The seeded approval id was not discovered.');
    await page.goto(`/persetujuan/${approvalId!}`);
    const detail = page.getByTestId('approval-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByText('Menunggu persetujuan Anda')).toBeVisible();
    await expect(detail.getByRole('heading', { name: SEEDED_SUMMARY })).toBeVisible();
  });

  test('RBAC-003.R02 a deep link outside the approver scope explains nothing technical', async ({ page }) => {
    await page.goto(`/persetujuan/${randomUUID()}`);
    await expect(page.getByRole('heading', { name: 'Tidak ada akses', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Kembali ke daftar' })).toBeVisible();
    // No HTTP status, error code, or stack trace reaches the approver (PLT-007.NC01).
    await expect(page.locator('main')).not.toContainText('PERMISSION_DENIED');
    await expect(page.locator('main')).not.toContainText('403');
  });

  test('APR-002.E1 a request somebody else already decided is reported as stale', async ({ page }) => {
    test.skip(approvalId === null, 'The seeded approval id was not discovered.');
    await page.goto(`/persetujuan/${approvalId!}`);
    await expect(page.getByTestId('approval-detail')).toBeVisible();
    markLocalApprovalDecided(approvalId!);
    await page.getByLabel('Alasan keputusan').fill('Sesuai kebijakan');
    await page.getByRole('button', { name: 'Setujui' }).click();
    await expect(page).toHaveURL(/\/persetujuan\?result=stale$/, { timeout: SIGN_IN_TIMEOUT });
    await expect(page.getByRole('status')).toContainText('sudah diproses petugas lain');
  });
});
