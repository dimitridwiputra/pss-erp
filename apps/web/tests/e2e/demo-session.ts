import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';

/**
 * Sign-in for the MVP demo path against the real local stack (Keycloak on 127.0.0.1:8080). The
 * demo passwords and OTP secrets are synthetic local test values in the main checkout's gitignored
 * `.local/` (written by scripts/setup-local-identity.mjs and by this helper); they never leave it.
 */
const localDirectory = resolve(dirname(resolve(process.cwd(), execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())), '.local');
const loginsFile = resolve(localDirectory, 'pss-mvp-demo-logins.txt');
const otpFile = resolve(localDirectory, 'pss-mvp-demo-otp.txt');

export type DemoUser = 'kasir.demo' | 'gudang.demo' | 'admin.demo' | 'keuangan.demo' | 'kepala.keuangan.demo';

async function password(username: DemoUser): Promise<string> {
  const logins = await readFile(loginsFile, 'utf8').catch(() => '');
  const match = new RegExp(`^Username: ${username.replaceAll('.', '\\.')}\\nPassword: (.+)$`, 'm').exec(logins);
  if (!match?.[1]) throw new Error(`No demo password for ${username}. Run pnpm dev:up (or scripts/setup-local-identity.mjs) first.`);
  return match[1];
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(bytes: Buffer): string {
  let bits = ''; let out = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  for (let index = 0; index < bits.length; index += 5) out += base32Alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  return out;
}
function base32Decode(text: string): Buffer {
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase()) bits += base32Alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP as Keycloak's default policy computes it: HMAC-SHA1, 6 digits, 30 s. */
export function totp(base32Secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(base32Secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

async function recordedSecret(username: DemoUser): Promise<string | null> {
  const recorded = await readFile(otpFile, 'utf8').catch(() => '');
  return new RegExp(`^${username.replaceAll('.', '\\.')} (\\S+)$`, 'm').exec(recorded)?.[1] ?? null;
}

async function recordSecret(username: DemoUser, secret: string): Promise<void> {
  const recorded = await readFile(otpFile, 'utf8').catch(() => '');
  const header = recorded ? '' : '# Synthetic local MVP demo OTP secrets (base32). Add one to an authenticator app with its otpauth link.\n';
  const link = `otpauth://totp/PSS%20Local:${username}?secret=${secret}&issuer=PSS%20Local&algorithm=SHA1&digits=6&period=30`;
  await writeFile(otpFile, `${recorded}${header}${username} ${secret}\n# ${link}\n`, { mode: 0o600 });
}

/** Signs `username` in on a fresh page; enrols the required authenticator on first use (MFA is met, never skipped). */
export async function signIn(page: Page, username: DemoUser): Promise<void> {
  await page.goto('/masuk');
  await page.getByRole('button', { name: /Masuk dengan akun PSS/ }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(await password(username));
  await page.locator('#kc-login').click();

  const next = await Promise.race([
    page.waitForURL(/\/beranda$/, { timeout: 20_000 }).then(() => 'home' as const),
    page.locator('#totpSecret').waitFor({ state: 'attached', timeout: 20_000 }).then(() => 'enrol' as const),
    page.locator('#otp').waitFor({ timeout: 20_000 }).then(() => 'otp' as const),
  ]);
  if (next === 'enrol') {
    const raw = await page.locator('#totpSecret').inputValue();
    const secret = base32Encode(Buffer.from(raw, 'utf8'));
    await recordSecret(username, secret);
    await page.locator('#totp').fill(totp(secret));
    await page.locator('#userLabel').fill('Demo MVP');
    await page.locator('#saveTOTPBtn').click();
  } else if (next === 'otp') {
    const secret = await recordedSecret(username);
    if (!secret) throw new Error(`${username} already has an authenticator this test did not enrol; add its secret to ${otpFile} or remove the OTP in Keycloak.`);
    await page.locator('#otp').fill(totp(secret));
    await page.locator('#kc-login').click();
  }
  await expect(page).toHaveURL(/\/beranda$/, { timeout: 20_000 });
}

/** One browser context per person, so each keeps its own session exactly as separate devices would. */
export async function personPage(browser: Browser, username: DemoUser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, username);
  return page;
}
