import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const CommandKeySchema = z.strictObject({
  organizationId: z.uuid(),
  identityId: z.string().min(1),
  commandName: z.string().min(1),
  key: z.string().min(1).max(200),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type CommandKey = z.input<typeof CommandKeySchema>;

export interface CommandResponse {
  code: number;
  body: unknown;
}

/** The application supplies its owning domain's guarded transaction runner. */
export type CommandTransactionRunner<TContext> = (
  client: PoolClient,
  work: (context: TContext) => Promise<CommandResponse>,
) => Promise<CommandResponse>;

export class IdempotencyError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_KEY_REQUIRED' | 'IDEMPOTENCY_KEY_REUSED' | 'REQUEST_IN_PROGRESS', message: string) {
    super(message);
  }
}

/** The supplied runner and command share the same transaction and commit boundary. */
export async function withIdempotentCommand<TContext>(
  pool: Pool,
  rawKey: CommandKey,
  runTransaction: CommandTransactionRunner<TContext>,
  execute: (transaction: TContext) => Promise<CommandResponse>,
): Promise<CommandResponse & { replayed: boolean }> {
  if (!rawKey.key) throw new IdempotencyError('IDEMPOTENCY_KEY_REQUIRED', 'Kunci permintaan diperlukan.');
  const key = CommandKeySchema.parse(rawKey);
  const scope = [key.organizationId, key.identityId, key.commandName, key.key];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM platform.idempotency_key
       WHERE organization_id = $1 AND identity_id = $2 AND command_name = $3
         AND idempotency_key = $4 AND expires_at <= now()`, scope,
    );
    const inserted = await client.query(
      `INSERT INTO platform.idempotency_key (
        organization_id, identity_id, command_name, idempotency_key, request_hash, status
      ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')
      ON CONFLICT DO NOTHING RETURNING idempotency_key`, [...scope, key.requestHash],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{
        request_hash: string; status: string; response_code: number | null; response_body: unknown;
      }>(
        `SELECT request_hash, status, response_code, response_body
         FROM platform.idempotency_key
         WHERE organization_id = $1 AND identity_id = $2 AND command_name = $3 AND idempotency_key = $4`, scope,
      );
      const record = existing.rows[0];
      if (!record) throw new Error('Idempotency key was not found after a conflict.');
      if (record.request_hash !== key.requestHash) {
        throw new IdempotencyError('IDEMPOTENCY_KEY_REUSED', 'Permintaan berbeda memakai kunci yang sama.');
      }
      if (record.status !== 'COMPLETED' || record.response_code === null) {
        throw new IdempotencyError('REQUEST_IN_PROGRESS', 'Permintaan sedang diproses.');
      }
      await client.query('COMMIT');
      return { code: record.response_code, body: record.response_body, replayed: true };
    }

    const response = await runTransaction(client, execute);
    if (!Number.isInteger(response.code) || response.code < 100 || response.code > 599) {
      throw new Error('Command response code must be an HTTP status.');
    }
    const body = JSON.stringify(response.body);
    if (body === undefined || Buffer.byteLength(body, 'utf8') > 16_384) {
      throw new Error('Command response body must be defined and at most 16 KiB.');
    }
    await client.query(
      `UPDATE platform.idempotency_key
       SET status = 'COMPLETED', response_code = $5, response_body = $6::jsonb
       WHERE organization_id = $1 AND identity_id = $2 AND command_name = $3 AND idempotency_key = $4`,
      [...scope, response.code, body],
    );
    await client.query('COMMIT');
    return { code: response.code, body: response.body, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Call from a daily maintenance job. Never removes keys younger than seven days. */
export async function deleteExpiredIdempotencyKeys(pool: Pool): Promise<number> {
  const result = await pool.query('DELETE FROM platform.idempotency_key WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}
