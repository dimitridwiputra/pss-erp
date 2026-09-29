import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withAuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';

/**
 * POS-000.R07 requires INVENTORY/FULFILLMENT = MANAGED (via the `principal-policy` resolver,
 * PRI-004) before a terminal can activate. `organization`/`principal-policy` are not part of
 * this build increment, so this guard is a documented no-op stub — see domains/pos/DOMAIN.md
 * "Open Decisions". Do not fabricate a policy result; wire the real resolver call here once
 * PRI-004 exists.
 */
function assertWarehouseManaged(_warehouseId: string): void {
  void _warehouseId;
  // Deferred: PRI-004 resolver not yet implemented (see DOMAIN.md).
}

const RegisterPosTerminalSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1),
  deviceId: z.uuid().optional(),
  printerProfile: z.record(z.string(), z.unknown()).optional(),
  actor: z.strictObject({ userId: z.uuid().optional(), roles: z.array(z.string()).default([]), serviceIdentity: z.string().optional() }),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type RegisterPosTerminalInput = z.input<typeof RegisterPosTerminalSchema>;

export interface PosTerminal {
  id: string;
  organizationId: string;
  branchId: string;
  warehouseId: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.',
  }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

export async function registerPosTerminal(pool: Pool, raw: RegisterPosTerminalInput): Promise<PosTerminal> {
  const input = parseOrThrow(RegisterPosTerminalSchema, raw);
  assertWarehouseManaged(input.warehouseId);
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO pos.pos_terminal (
        id, organization_id, branch_id, warehouse_id, code, name, device_id, printer_profile, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'ACTIVE')`,
      [
        id, input.organizationId, input.branchId, input.warehouseId, input.code, input.name,
        input.deviceId ?? null, input.printerProfile ? JSON.stringify(input.printerProfile) : null,
      ],
    );
    await appendAuditEntry({
      organizationId: input.organizationId, branchId: input.branchId, actor: input.actor,
      action: 'POS_TERMINAL_UPDATED',
      entity: { domain: 'pos', type: 'PosTerminal', id, version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', after: 'ACTIVE' }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    return { id, organizationId: input.organizationId, branchId: input.branchId, warehouseId: input.warehouseId, code: input.code, name: input.name, status: 'ACTIVE' as const };
  });
}

const DeactivatePosTerminalSchema = z.strictObject({
  terminalId: z.uuid(),
  actor: z.strictObject({ userId: z.uuid().optional(), roles: z.array(z.string()).default([]), serviceIdentity: z.string().optional() }),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type DeactivatePosTerminalInput = z.input<typeof DeactivatePosTerminalSchema>;

export async function deactivatePosTerminal(pool: Pool, raw: DeactivatePosTerminalInput): Promise<void> {
  const input = parseOrThrow(DeactivatePosTerminalSchema, raw);
  await withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const openShift = await client.query('SELECT id FROM pos.pos_shift WHERE terminal_id = $1 AND status = $2', [input.terminalId, 'OPEN']);
    if ((openShift.rowCount ?? 0) > 0) throw new DomainError('POS_SHIFT_STILL_OPEN');
    const terminal = await client.query<{ organization_id: string; branch_id: string }>(
      'SELECT organization_id, branch_id FROM pos.pos_terminal WHERE id = $1', [input.terminalId],
    );
    const row = terminal.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    await client.query("UPDATE pos.pos_terminal SET status = 'INACTIVE', updated_at = now() WHERE id = $1", [input.terminalId]);
    await appendAuditEntry({
      organizationId: row.organization_id, branchId: row.branch_id, actor: input.actor,
      action: 'POS_TERMINAL_UPDATED',
      entity: { domain: 'pos', type: 'PosTerminal', id: input.terminalId, version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', before: 'ACTIVE', after: 'INACTIVE' }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
  });
}
