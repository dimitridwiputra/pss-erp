import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiPool } from '../apps/api/src/database-pool';

describe('API database pool', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('survives an idle connection being cut instead of crashing the process', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@127.0.0.1:1/none');
    const pool = createApiPool();
    expect(pool).toBeDefined();
    // Without a listener, EventEmitter throws on an unhandled 'error' — that was the API exiting.
    expect(() => pool!.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).not.toThrow();
    await pool!.end();
  });

  it('has no pool without a database URL', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(createApiPool()).toBeUndefined();
  });
});
