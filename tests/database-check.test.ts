import { describe, expect, it } from 'vitest';
import { checkMigration } from '../scripts/check-database.mjs';

const path = 'domains/orders/infrastructure/database/migrations/0001_orders.sql';

describe('PLT-002 migration gate', () => {
  it('rejects DROP COLUMN without an explicit migration plan', () => {
    expect(checkMigration({ path, sql: 'ALTER TABLE sales.sales_order DROP COLUMN legacy_code;' }))
      .toEqual([expect.stringContaining('requires a sibling .migration-plan.md')]);
  });

  it('rejects a table outside its owner schema and an unqualified table', () => {
    expect(checkMigration({ path, sql: 'CREATE TABLE finance.journal (id uuid); CREATE TABLE unknown (id uuid);' }))
      .toEqual(expect.arrayContaining([expect.stringContaining('cannot create or alter'), expect.stringContaining('explicit owner schema')]));
  });

  it('rejects a cross-schema foreign key', () => {
    expect(checkMigration({ path, sql: 'CREATE TABLE sales.sales_order (id uuid REFERENCES core.customer(id));' }))
      .toEqual([expect.stringContaining('cross-schema foreign key')]);
  });

  it('accepts a forward-only migration in its owner schema', () => {
    expect(checkMigration({ path, sql: 'CREATE TABLE sales.sales_order (id uuid PRIMARY KEY);' })).toEqual([]);
  });

  it('does not mistake a TRUNCATE permission revoke for data deletion', () => {
    expect(checkMigration({ path, sql: 'REVOKE UPDATE, DELETE, TRUNCATE ON sales.sales_order FROM PUBLIC;' })).toEqual([]);
    expect(checkMigration({ path, sql: 'CREATE TRIGGER no_truncate BEFORE TRUNCATE ON sales.sales_order EXECUTE FUNCTION audit.reject_entry_mutation();' })).toEqual([]);
  });

  it('rejects destructive SQL inside a migration block', () => {
    expect(checkMigration({ path, sql: 'DO $$ BEGIN TRUNCATE TABLE sales.sales_order; END $$;' }))
      .toEqual([expect.stringContaining('requires a sibling .migration-plan.md')]);
  });
});
