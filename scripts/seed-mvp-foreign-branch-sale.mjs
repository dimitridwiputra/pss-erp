import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * Test fixture for the MVP demo path's wrong-branch exception (apps/web/tests/e2e/mvp-demo-path.spec.ts):
 * a paid counter sale in a second branch of the demo organization. It lives here, not in the web
 * test, because web code may not reach a database (PLT-002). Prints the sale id.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational';
const demo = JSON.parse(await readFile(new URL('../infrastructure/keycloak/pss-demo-users.json', import.meta.url), 'utf8'));
const organizationId = demo.organization.id;
const [terminalId, shiftId, saleId, branchId, warehouseId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO pos.pos_terminal (id, organization_id, branch_id, warehouse_id, code, name, status) VALUES ($1, $2, $3, $4, $5, 'Konter Cabang Lain', 'ACTIVE')`,
    [terminalId, organizationId, branchId, warehouseId, `KSR-X${Date.now() % 100000}`],
  );
  await client.query(`INSERT INTO pos.pos_shift (id, organization_id, terminal_id, cashier_user_id, opening_float, status) VALUES ($1, $2, $3, $4, 0, 'CLOSED')`, [shiftId, organizationId, terminalId, randomUUID()]);
  await client.query(
    `INSERT INTO pos.pos_sale (id, organization_id, terminal_id, shift_id, status, invoice_number, total, checked_out_at) VALUES ($1, $2, $3, $4, 'PAID', $5, 118000, now())`,
    [saleId, organizationId, terminalId, shiftId, `INV-X-${Date.now()}`],
  );
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
process.stdout.write(`${saleId}\n`);
