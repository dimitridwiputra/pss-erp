import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { adjustStock } from '@pss/inventory';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from '@pss/platform';

const ReportTypeSchema = z.enum(['DAMAGED', 'MISSING', 'EXCESS', 'WRONG_LOCATION']);

const ReportStockDiscrepancyInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  locationCode: z.string().min(1),
  productId: z.uuid(),
  uom: z.string().min(1),
  reportType: ReportTypeSchema,
  qty: DecimalStringSchema,
  reasonCode: z.string().min(1),
  evidenceMediaIds: z.array(z.string().min(1)).default([]),
  ...OptionalAuditContextSchema.shape,
});
export type ReportStockDiscrepancyInput = z.input<typeof ReportStockDiscrepancyInputSchema>;

/**
 * WMS-011 "Laporkan Masalah": any operator, from any task, reports a physical exception.
 * WMS-011.BR01: this alone never changes the financial balance — only `resolveStockDiscrepancy`
 * does, and only once ADJUSTED. WMS-011.BR02: a DAMAGED report requires at least one evidence
 * photo (`EVIDENCE_PHOTO_REQUIRED`). Physically moving damaged stock to a QUARANTINE location
 * (WMS-011.R02) is deferred to a future `putawayStock` call by the operator, not automated here.
 */
export async function reportStockDiscrepancy(pool: Pool, client: PoolClient | undefined, input: ReportStockDiscrepancyInput): Promise<{ id: string }> {
  const parsed = ReportStockDiscrepancyInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ id: string }> => {
    const tx = transaction.client;

    if (parsed.reportType === 'DAMAGED' && parsed.evidenceMediaIds.length === 0) throw new DomainError('EVIDENCE_PHOTO_REQUIRED');

    const location = await tx.query<{ id: string }>(`SELECT id FROM wms.warehouse_location WHERE warehouse_id = $1 AND code = $2`, [parsed.warehouseId, parsed.locationCode]);
    const locationRow = location.rows[0];
    if (!locationRow) throw new DomainError('NOT_FOUND');

    const id = randomUUID();
    await tx.query(
      `INSERT INTO wms.stock_discrepancy_report (
         id, organization_id, warehouse_id, location_id, product_id, uom, report_type, qty, reason_code,
         evidence_media_ids, status, reported_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'REPORTED', $11)`,
      [id, parsed.organizationId, parsed.warehouseId, locationRow.id, parsed.productId, parsed.uom, parsed.reportType, parsed.qty, parsed.reasonCode, JSON.stringify(parsed.evidenceMediaIds), parsed.actor?.userId ?? null],
    );

    const auditContext = resolveAuditContext(parsed, id);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'STOCK_DISCREPANCY_REPORTED',
      entity: { domain: 'wms', type: 'StockDiscrepancyReport', id, version: 1 },
      changes: [{ path: 'reportType', classification: 'INTERNAL' as const, after: parsed.reportType }, { path: 'qty', classification: 'INTERNAL' as const, after: parsed.qty }],
      reasonCode: parsed.reasonCode,
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { id };
  };

  return withConnection(pool, client, work);
}

const ResolveStockDiscrepancyInputSchema = z.strictObject({
  reportId: z.uuid(),
  decision: z.enum(['ADJUST', 'REJECT']),
  ...OptionalAuditContextSchema.shape,
});
export type ResolveStockDiscrepancyInput = z.input<typeof ResolveStockDiscrepancyInputSchema>;

/**
 * Completes a WMS-011 report — the P0 stand-in for the full INV-006 approval workflow (which does
 * not exist yet): a supervisor either ADJUSTs (posts the correction immediately, via
 * `inventory.adjustStock` plus this domain's own `wms.physical_stock`) or REJECTs it (no state
 * change beyond the report itself). `WRONG_LOCATION` reports cannot be ADJUSTed here — moving
 * stock between locations has no financial impact and belongs to `putawayStock`, not this command
 * (deferred: see DOMAIN.md open decisions).
 */
export async function resolveStockDiscrepancy(pool: Pool, client: PoolClient | undefined, input: ResolveStockDiscrepancyInput): Promise<{ id: string; status: string }> {
  const parsed = ResolveStockDiscrepancyInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ id: string; status: string }> => {
    const tx = transaction.client;

    const report = await tx.query<{
      organization_id: string; warehouse_id: string; location_id: string; product_id: string; uom: string;
      report_type: string; qty: string; reason_code: string; status: string;
    }>(`SELECT organization_id, warehouse_id, location_id, product_id, uom, report_type, qty, reason_code, status FROM wms.stock_discrepancy_report WHERE id = $1 FOR UPDATE`, [parsed.reportId]);
    const reportRow = report.rows[0];
    if (!reportRow) throw new DomainError('NOT_FOUND');
    if (reportRow.status !== 'REPORTED') throw new DomainError('INVALID_STATE_TRANSITION');

    const status = parsed.decision === 'ADJUST' ? 'ADJUSTED' : 'REJECTED';

    if (parsed.decision === 'ADJUST') {
      if (reportRow.report_type === 'WRONG_LOCATION') {
        throw new DomainError('VALIDATION_FAILED', [], [{ path: 'decision', code: 'not_adjustable', message: 'Selisih lokasi salah diselesaikan lewat putaway, bukan penyesuaian.' }]);
      }
      const qtyDelta = reportRow.report_type === 'EXCESS' ? reportRow.qty : `-${reportRow.qty}`;

      const updated = await tx.query(
        `UPDATE wms.physical_stock SET qty_on_hand = qty_on_hand + $1::numeric, version = version + 1, updated_at = now()
         WHERE location_id = $2 AND product_id = $3 AND qty_on_hand + $1::numeric >= qty_allocated
         RETURNING id`,
        [qtyDelta, reportRow.location_id, reportRow.product_id],
      );
      if (updated.rowCount === 0) {
        throw new DomainError('VALIDATION_FAILED', [], [{ path: 'qty', code: 'below_allocated', message: 'Penyesuaian membuat stok fisik di bawah yang sudah teralokasi.' }]);
      }

      await adjustStock(pool, tx, {
        organizationId: reportRow.organization_id,
        warehouseId: reportRow.warehouse_id,
        referenceType: 'WMS_DISCREPANCY',
        referenceId: parsed.reportId,
        lines: [{ productId: reportRow.product_id, uom: reportRow.uom, qtyDelta, reasonCode: reportRow.reason_code }],
      });
    }

    await tx.query(`UPDATE wms.stock_discrepancy_report SET status = $2, resolved_at = now() WHERE id = $1`, [parsed.reportId, status]);

    const auditContext = resolveAuditContext(parsed, parsed.reportId);
    await transaction.appendAuditEntry({
      organizationId: reportRow.organization_id,
      actor: auditContext.actor,
      action: parsed.decision === 'ADJUST' ? 'STOCK_DISCREPANCY_ADJUSTED' : 'STOCK_DISCREPANCY_REJECTED',
      entity: { domain: 'wms', type: 'StockDiscrepancyReport', id: parsed.reportId, version: 2 },
      changes: [{ path: 'status', classification: 'INTERNAL' as const, before: 'REPORTED', after: status }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { id: parsed.reportId, status };
  };

  return withConnection(pool, client, work);
}
