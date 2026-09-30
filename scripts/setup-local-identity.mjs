import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const fetch = globalThis.fetch;

const issuer = 'http://127.0.0.1:8080/realms/pss-local';
const adminBase = 'http://127.0.0.1:8080/admin/realms/pss-local';
const root = new URL('../', import.meta.url);
const webEnvironmentPath = new URL('apps/web/.env.local', root);
/**
 * Keycloak is one container shared by every checkout, so its passwords must be recorded in one
 * place too. In a git worktree `.local/` resolves to the main checkout's; otherwise a second
 * worktree would find no file, reset the passwords, and lock the first checkout out.
 */
const credentialsRoot = pathToFileURL(`${dirname(resolve(fileURLToPath(root), execFileSync('git', ['rev-parse', '--git-common-dir'], {
  cwd: fileURLToPath(root), encoding: 'utf8',
}).trim()))}/`);
const localDirectory = new URL('.local/', credentialsRoot);
const loginPath = new URL('pss-demo-login.txt', localDirectory);
const mvpDemoLoginPath = new URL('pss-mvp-demo-logins.txt', localDirectory);
const mvpDemoSeedPath = new URL('infrastructure/keycloak/pss-demo-users.json', root);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to create the synthetic local account.');

async function waitForKeycloak() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (response.ok) return;
    } catch { /* Keycloak may still be starting. */ }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2500));
  }
  throw new Error('Local Keycloak did not become ready within 60 seconds.');
}

function localAdminPassword() {
  const compose = JSON.parse(execFileSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: fileURLToPath(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const password = compose.services?.keycloak?.environment?.KC_BOOTSTRAP_ADMIN_PASSWORD;
  if (typeof password !== 'string' || !password) throw new Error('Local Keycloak admin password is missing from Compose.');
  return password;
}

async function adminToken() {
  const response = await fetch('http://127.0.0.1:8080/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new globalThis.URLSearchParams({
      grant_type: 'password', client_id: 'admin-cli',
      username: 'pss_local', password: localAdminPassword(),
    }),
  });
  if (!response.ok) throw new Error(`Local Keycloak admin login returned HTTP ${response.status}.`);
  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new Error('Local Keycloak admin token is missing.');
  return body.access_token;
}

async function keycloakRequest(path, token, options = {}) {
  return fetch(`${adminBase}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
  });
}

async function ensureApiAudience(token) {
  const clientsResponse = await keycloakRequest('/clients?clientId=pss-web', token);
  if (!clientsResponse.ok) throw new Error('Cannot read the local PSS web client.');
  const clients = await clientsResponse.json();
  const client = clients[0];
  const clientId = client?.id;
  if (!clientId) throw new Error('The local PSS web client is missing.');
  const redirectUris = [
    'http://localhost:3000/api/auth/callback/keycloak',
    'http://127.0.0.1:3000/api/auth/callback/keycloak',
  ];
  const webOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  if (redirectUris.some((uri) => !client.redirectUris?.includes(uri)) ||
      webOrigins.some((origin) => !client.webOrigins?.includes(origin))) {
    const updated = await keycloakRequest(`/clients/${clientId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ ...client, redirectUris, webOrigins }),
    });
    if (!updated.ok) throw new Error(`Local web client setup returned HTTP ${updated.status}.`);
  }
  const mapperPath = `/clients/${clientId}/protocol-mappers/models`;
  const mappersResponse = await keycloakRequest(mapperPath, token);
  if (!mappersResponse.ok) throw new Error('Cannot read local Keycloak audience mappers.');
  const mappers = await mappersResponse.json();
  for (const mapper of [
    {
      name: 'pss-api-audience', protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper', consentRequired: false,
      config: { 'included.custom.audience': 'pss-api', 'access.token.claim': 'true', 'id.token.claim': 'false' },
    },
    {
      name: 'pss-authentication-methods', protocol: 'openid-connect',
      protocolMapper: 'oidc-amr-mapper', consentRequired: false,
      config: { 'access.token.claim': 'true', 'id.token.claim': 'true' },
    },
  ]) {
    if (mappers.some((existing) => existing.name === mapper.name)) continue;
    const created = await keycloakRequest(mapperPath, token, { method: 'POST', body: JSON.stringify(mapper) });
    if (!created.ok) throw new Error(`Local ${mapper.name} mapper returned HTTP ${created.status}.`);
  }
}

/**
 * Keycloak 26's AMR mapper reports only the methods whose flow step names an authenticator
 * reference, and the built-in browser flow names none, so `amr` came out empty even after an OTP
 * login and every approval failed `requireRecentMfa` with MFA_REQUIRED. This gives the password
 * step `pwd` and the OTP step `otp` (RFC 8176). It makes the MFA check work as designed; it does not
 * relax it.
 */
async function ensureAuthenticationReferences(token) {
  const references = { 'auth-username-password-form': 'pwd', 'auth-otp-form': 'otp' };
  const executionsResponse = await keycloakRequest('/authentication/flows/browser/executions', token);
  if (!executionsResponse.ok) throw new Error(`Local browser flow read returned HTTP ${executionsResponse.status}.`);
  for (const execution of await executionsResponse.json()) {
    const reference = references[execution.providerId];
    if (!reference) continue;
    if (execution.authenticationConfig) {
      const configPath = `/authentication/config/${execution.authenticationConfig}`;
      const existing = await (await keycloakRequest(configPath, token)).json();
      if (existing.config?.['default.reference.value'] === reference) continue;
      const updated = await keycloakRequest(configPath, token, {
        method: 'PUT', body: JSON.stringify({ ...existing, config: { ...existing.config, 'default.reference.value': reference } }),
      });
      if (!updated.ok) throw new Error(`Local ${execution.providerId} reference update returned HTTP ${updated.status}.`);
      continue;
    }
    const created = await keycloakRequest(`/authentication/executions/${execution.id}/config`, token, {
      method: 'POST', body: JSON.stringify({ alias: `pss-amr-${reference}`, config: { 'default.reference.value': reference } }),
    });
    if (created.status !== 201) throw new Error(`Local ${execution.providerId} reference returned HTTP ${created.status}.`);
  }
}

async function ensureDemoUser(token) {
  const username = 'pss-demo-admin';
  const usersPath = `/users?username=${encodeURIComponent(username)}&exact=true`;
  const existingResponse = await keycloakRequest(usersPath, token);
  if (!existingResponse.ok) throw new Error('Cannot search the local Keycloak users.');
  let users = await existingResponse.json();
  if (!users.length) {
    const created = await keycloakRequest('/users', token, {
      method: 'POST',
      body: JSON.stringify({ username, enabled: true, firstName: 'Admin', lastName: 'Demo PSS', email: 'pss-demo-admin@example.test' }),
    });
    if (created.status !== 201) throw new Error(`Local demo user creation returned HTTP ${created.status}.`);
    const query = await keycloakRequest(usersPath, token);
    users = await query.json();
  }
  const subject = users[0]?.id;
  if (!subject) throw new Error('Local demo user has no subject.');
  if (!users[0].email) {
    const updated = await keycloakRequest(`/users/${subject}`, token, {
      method: 'PUT',
      body: JSON.stringify({ ...users[0], email: 'pss-demo-admin@example.test' }),
    });
    if (!updated.ok) throw new Error(`Local demo profile setup returned HTTP ${updated.status}.`);
  }
  const existingLogin = await readFile(loginPath, 'utf8').catch(() => null);
  if (!existingLogin) {
    const password = randomBytes(18).toString('base64url');
    const reset = await keycloakRequest(`/users/${subject}/reset-password`, token, {
      method: 'PUT',
      body: JSON.stringify({ type: 'password', value: password, temporary: false }),
    });
    if (reset.status !== 204) throw new Error(`Local demo password setup returned HTTP ${reset.status}.`);
    await mkdir(localDirectory, { recursive: true });
    await writeFile(loginPath, `Synthetic local development account only\nUsername: ${username}\nPassword: ${password}\n`, { mode: 0o600 });
  }
  return subject;
}

async function ensurePssMapping(subject) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const existing = await pool.query('SELECT id FROM identity.user_account WHERE idp_subject = $1', [subject]);
    const userId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rowCount) {
      await pool.query(
        `INSERT INTO identity.user_account
         (id, organization_id, idp_subject, display_name, primary_branch_id, status)
         VALUES ($1, $2, $3, 'Admin Demo PSS', $4, 'ACTIVE')`,
        [userId, randomUUID(), subject, randomUUID()],
      );
    }
    const account = await pool.query('SELECT primary_branch_id FROM identity.user_account WHERE id = $1', [userId]);
    await pool.query(
      "UPDATE identity.user_account SET status = 'ACTIVE', updated_at = now() WHERE id = $1 AND display_name = 'Admin Demo PSS' AND status <> 'ACTIVE'",
      [userId],
    );
    await pool.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'SALES_ADMIN', 'BRANCH', $3) ON CONFLICT DO NOTHING`,
      [randomUUID(), userId, account.rows[0].primary_branch_id],
    );
  } finally {
    await pool.end();
  }
}

/**
 * MVP demo users (docs/mvp/MVP_PLAN.md §7) from `infrastructure/keycloak/pss-demo-users.json`.
 * The seed file carries identities and role assignments only; each password is generated here once
 * and written to `.local/pss-mvp-demo-logins.txt`, so no credential is ever committed. Re-running
 * keeps existing passwords and is safe: every write is keyed by a fixed user ID or by the unique
 * active-assignment index. This is a local fixture, like the account above; IDN-003 owns the
 * audited assignment command for real accounts.
 */
async function ensureMvpDemoUsers(token) {
  const seed = JSON.parse(await readFile(mvpDemoSeedPath, 'utf8'));
  // Appendix D marks some roles `mfaRequired`, and approval decisions call `requireRecentMfa`. The
  // demo meets that control rather than skipping it: such a user must enrol an authenticator app
  // on first login, after which the default browser flow's conditional OTP puts `otp` in `amr`.
  const { registryCatalog } = createRequire(import.meta.url)('../packages/contracts/dist/index.js');
  const mfaRoles = new Set(registryCatalog.roles.filter((role) => role.mfaRequired).map((role) => role.code));
  const scopeIds = { ORGANIZATION: seed.organization.id, BRANCH: seed.branch.id, WAREHOUSE: seed.warehouse.id };
  const recorded = await readFile(mvpDemoLoginPath, 'utf8').catch(() => '');
  const newLogins = [];
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    for (const user of seed.users) {
      const usersPath = `/users?username=${encodeURIComponent(user.username)}&exact=true`;
      let users = await (await keycloakRequest(usersPath, token)).json();
      if (!users.length) {
        const [firstName, ...rest] = user.displayName.split(' ');
        const created = await keycloakRequest('/users', token, {
          method: 'POST',
          body: JSON.stringify({
            username: user.username, enabled: true, emailVerified: true,
            firstName, lastName: rest.join(' ') || firstName, email: `${user.username}@example.test`,
          }),
        });
        if (created.status !== 201) throw new Error(`Demo user ${user.username} creation returned HTTP ${created.status}.`);
        users = await (await keycloakRequest(usersPath, token)).json();
      }
      const subject = users[0]?.id;
      if (!subject) throw new Error(`Demo user ${user.username} has no subject.`);
      if (user.roles.some((role) => mfaRoles.has(role.roleCode))) {
        const credentials = await (await keycloakRequest(`/users/${subject}/credentials`, token)).json();
        const hasOtp = credentials.some((credential) => credential.type === 'otp');
        if (!hasOtp && !users[0].requiredActions?.includes('CONFIGURE_TOTP')) {
          const updated = await keycloakRequest(`/users/${subject}`, token, {
            method: 'PUT',
            body: JSON.stringify({ ...users[0], requiredActions: [...(users[0].requiredActions ?? []), 'CONFIGURE_TOTP'] }),
          });
          if (!updated.ok) throw new Error(`Demo MFA enrolment for ${user.username} returned HTTP ${updated.status}.`);
        }
      }
      if (!new RegExp(`^Username: ${user.username.replaceAll('.', '\\.')}$`, 'm').test(recorded)) {
        const password = randomBytes(18).toString('base64url');
        const reset = await keycloakRequest(`/users/${subject}/reset-password`, token, {
          method: 'PUT', body: JSON.stringify({ type: 'password', value: password, temporary: false }),
        });
        if (reset.status !== 204) throw new Error(`Demo password setup for ${user.username} returned HTTP ${reset.status}.`);
        newLogins.push(`Username: ${user.username}\nPassword: ${password}\n`);
      }
      await pool.query(
        `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, primary_branch_id, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
         ON CONFLICT (id) DO UPDATE SET idp_subject = EXCLUDED.idp_subject, status = 'ACTIVE', updated_at = now()`,
        [user.userId, seed.organization.id, subject, user.displayName, seed.branch.id],
      );
      for (const role of user.roles) {
        await pool.query(
          `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [randomUUID(), user.userId, role.roleCode, role.scopeType, scopeIds[role.scopeType]],
        );
      }
    }
  } finally {
    await pool.end();
  }
  if (newLogins.length) {
    await mkdir(localDirectory, { recursive: true });
    const header = recorded ? '' : 'Synthetic local MVP demo accounts only (docs/mvp/MVP_PLAN.md §7)\n\n';
    await writeFile(mvpDemoLoginPath, `${recorded}${header}${newLogins.join('\n')}`, { mode: 0o600 });
  }
}

async function ensureWebEnvironment() {
  const existing = await readFile(webEnvironmentPath, 'utf8').catch(() => '');
  const values = {
    AUTH_SECRET: randomBytes(48).toString('base64url'),
    AUTH_KEYCLOAK_ID: 'pss-web',
    AUTH_KEYCLOAK_ISSUER: issuer,
    AUTH_TRUST_HOST: 'true',
    PSS_API_BASE_URL: 'http://127.0.0.1:4000',
    PSS_FINANCE_API_BASE_URL: 'http://127.0.0.1:4001',
  };
  const missing = Object.entries(values).filter(([key]) => !new RegExp(`^${key}=`, 'm').test(existing));
  if (missing.length) {
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    await writeFile(webEnvironmentPath, `${existing}${separator}${missing.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  }
  await chmod(webEnvironmentPath, 0o600);
}

await waitForKeycloak();
const token = await adminToken();
await ensureApiAudience(token);
await ensureAuthenticationReferences(token);
const subject = await ensureDemoUser(token);
await ensurePssMapping(subject);
await ensureMvpDemoUsers(token);
await ensureWebEnvironment();
process.stdout.write('Local PSS identity ready. Demo sign-in details are in .local/pss-demo-login.txt and .local/pss-mvp-demo-logins.txt.\n');
