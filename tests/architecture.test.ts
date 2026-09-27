import { describe, expect, it } from 'vitest';
import { findArchitectureViolations } from '../scripts/check-architecture.mjs';

const root = '/work/pss-erp';

describe('PLT-002 import boundaries', () => {
  it('rejects a domain importing another domain internals', () => {
    const violations = findArchitectureViolations([{
      path: `${root}/domains/sfa/application/submit.ts`,
      source: "import { Order } from '../../orders/domain/order';",
    }]);
    expect(violations).toEqual([expect.stringContaining('cross-domain internals')]);
  });

  it('rejects package-to-domain and BFF-to-database imports', () => {
    const violations = findArchitectureViolations([
      { path: `${root}/packages/contracts/src/index.ts`, source: "export { Order } from '../../../domains/orders/domain/order';" },
      { path: `${root}/apps/web/app/page.tsx`, source: "import { PrismaClient } from '@prisma/client';" },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('packages cannot import domains');
    expect(violations[1]).toContain('cannot access a database');
  });

  it('accepts a shared contract import', () => {
    expect(findArchitectureViolations([{
      path: `${root}/domains/sfa/application/submit.ts`,
      source: "import { EventNameSchema } from '@pss/contracts';",
    }])).toEqual([]);
  });

  it('PLT-002.AC01 rejects workspace aliases into domain internals', () => {
    const packages = new Map([['@pss/orders', `${root}/domains/orders`]]);
    expect(findArchitectureViolations([{
      path: `${root}/domains/sfa/application/submit.ts`,
      source: "import { Order } from '@pss/orders/domain/order';",
    }], packages)).toEqual([expect.stringContaining('cross-domain internals')]);
  });

  it('rejects Platform-to-domain aliases and package-to-domain aliases', () => {
    const packages = new Map([['@pss/audit', `${root}/domains/audit`]]);
    const violations = findArchitectureViolations([
      { path: `${root}/domains/platform/src/application/idempotency.ts`, source: "import { runAuditedWork } from '@pss/audit';" },
      { path: `${root}/packages/contracts/src/index.ts`, source: "export { runAuditedWork } from '@pss/audit';" },
    ], packages);
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('platform cannot import a business domain'),
      expect.stringContaining('packages cannot import domains'),
    ]));
  });

  it('rejects direct reads and writes to another domain schema', () => {
    const violations = findArchitectureViolations([{
      path: `${root}/domains/orders/src/infrastructure/order-repository.ts`,
      source: "await client.query('SELECT * FROM finance.journal'); await client.query('INSERT INTO ar.receivable (id) VALUES ($1)', [id]);",
    }]);
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('queries finance.journal'),
      expect.stringContaining('queries ar.receivable'),
    ]));
  });

  it('RBAC-001.AC03 rejects role-name authorization branches', () => {
    const violations = findArchitectureViolations([{
      path: `${root}/apps/api/src/orders.controller.ts`,
      source: "if (actor.role === 'CASHIER') return approvePayment();",
    }]);
    expect(violations).toEqual([expect.stringContaining('authorize by permission and scope')]);
  });
});
