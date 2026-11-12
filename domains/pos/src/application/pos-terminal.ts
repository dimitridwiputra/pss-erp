import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { parseOrThrow, RequestMetaShape } from './support/command-input';

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
  name: z.string().min(1).max(80),
  deviceId: z.uuid().optional(),
  printerProfile: z.record(z.string(), z.unknown()).optional(),
  ...RequestMetaShape,
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

export async function registerPosTerminal(pool: Pool, client: PoolClient | undefined, raw: RegisterPosTerminalInput): Promise<PosTerminal> {
  const input = parseOrThrow(RegisterPosTerminalSchema, raw);
  assertWarehouseManaged(input.warehouseId);
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const id = randomUUID();
    try {
      await client.query(
        `INSERT INTO pos.pos_terminal (
          id, organization_id, branch_id, warehouse_id, code, name, device_id, printer_profile, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'ACTIVE')`,
        [
          id, input.organizationId, input.branchId, input.warehouseId, input.code, input.name,
          input.deviceId ?? null, input.printerProfile ? JSON.stringify(input.printerProfile) : null,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('DUPLICATE_CODE');
      throw error;
    }
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

const DeactivatePosTerminalSchema = z.strictObject({ terminalId: z.uuid(), ...RequestMetaShape });
export type DeactivatePosTerminalInput = z.input<typeof DeactivatePosTerminalSchema>;

export async function deactivatePosTerminal(pool: Pool, client: PoolClient | undefined, raw: DeactivatePosTerminalInput): Promise<void> {
  const input = parseOrThrow(DeactivatePosTerminalSchema, raw);
  await withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const terminal = await client.query<{ organization_id: string; branch_id: string; status: string; version: number }>(
      'SELECT organization_id, branch_id, status, version FROM pos.pos_terminal WHERE id = $1 FOR UPDATE', [input.terminalId],
    );
    const row = terminal.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status !== 'ACTIVE') throw new DomainError('INVALID_STATE_TRANSITION');
    const openShift = await client.query('SELECT id FROM pos.pos_shift WHERE terminal_id = $1 AND status = $2', [input.terminalId, 'OPEN']);
    if ((openShift.rowCount ?? 0) > 0) throw new DomainError('POS_SHIFT_STILL_OPEN');
    await client.query("UPDATE pos.pos_terminal SET status = 'INACTIVE', version = version + 1, updated_at = now() WHERE id = $1", [input.terminalId]);
    await appendAuditEntry({
      organizationId: row.organization_id, branchId: row.branch_id, actor: input.actor,
      action: 'POS_TERMINAL_UPDATED',
      entity: { domain: 'pos', type: 'PosTerminal', id: input.terminalId, version: row.version + 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', before: 'ACTIVE', after: 'INACTIVE' }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
  });
}
