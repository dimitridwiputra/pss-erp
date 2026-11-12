import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function demoCredentials() {
  const login = await readFile(resolve(process.cwd(), '../../.local/pss-demo-login.txt'), 'utf8');
  const username = login.match(/^Username: (.+)$/m)?.[1];
  const password = login.match(/^Password: (.+)$/m)?.[1];
  if (!username || !password) throw new Error('Run pnpm dev:up to prepare the local demo account.');
  return { username, password };
}

async function signInAsDemo(page: Page) {
  await page.goto('/masuk');
  await page.getByRole('button', { name: /Masuk dengan akun PSS/ }).click();

  const { username, password } = await demoCredentials();
  await page.getByRole('textbox', { name: /username|email/i }).fill(username);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/beranda$/, { timeout: 20_000 });
}

test('a mapped PSS account can sign in, see its access, and sign out', async ({ page }) => {
  await page.goto('/beranda');
  await expect(page).toHaveURL(/\/masuk$/);
  await signInAsDemo(page);
  await expect(page.getByRole('heading', { name: 'Pekerjaan Anda' })).toBeVisible();
  await expect(page.getByText('Selamat datang, Admin Demo PSS.')).toBeVisible();
  await expect(page.getByRole('list').getByText('PSS Admin', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keluar' }).click();
  await expect(page).toHaveURL(/\/masuk$/, { timeout: 20_000 });
  await page.goto('/beranda');
  await expect(page).toHaveURL(/\/masuk$/);
});
