import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  CashHandoverListQuerySchema, CashHandoverListResponseSchema, CashHandoverSchema, DomainError,
  PosDashboardSummaryQuerySchema, PosSalesTrendQuerySchema, PosSalesTrendResponseSchema, PosDashboardSummaryResponseSchema, PosInvoiceCopyResponseSchema, PosSalesListQuerySchema,
  PosSalesListResponseSchema, PosSalesReportDetailSchema, PrintPosInvoiceCopyRequestSchema, VerifyCashHandoverRequestSchema,
  type CashHandover, type CurrentUserResponse, type PrintPosInvoiceCopyRequest, type VerifyCashHandoverRequest,
} from '@pss/contracts';
import { readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { getUserDisplayNames, scopeIdsFor } from '@pss/identity';
import type { ObservedRequest } from '@pss/observability';
import {
  getCashCustodyRecord, getUndepositedPosCash, listCashCustodyRecords, verifyCashCustody, type CashCustodyRecordView,
} from '@pss/payments';
import {
  getBranchesOfWarehouses, getPosSale, getPosSaleScope, getPosSalesListItem, getPosSalesSummary, getPosSalesTrend, getPosShiftSummaries, listPosSales, printPosReceipt,
} from '@pss/pos';
import { Pool } from 'pg';
import { createApiPool } from './database-pool';
import { z } from 'zod';
import {
  authorizeAt, commandContext, commandMeta, inOrganization, requireHeldPermission, runApiCommand, uuidParam, type CommandContext,
} from './api-command';
import { DemoPosFeatureGuard } from './demo-pos-guard';
import { IdentityService } from './identity.controller';

type ApiRequest = ObservedRequest;

const SALES_REPORT = 'pos.report.view';
const INVOICE_COPY = 'invoicing.invoice.print';
const CASH_VERIFY = 'payments.cash_custody.verify';

function jakartaBusinessDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** A query string parsed against its allow-listed contract; anything else is a 422 with field paths. */
function parseQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'query', code: issue.code, message: issue.message.startsWith('Tanggal') ? issue.message : 'Periksa nilai ini.',
  })));
}

/**
 * The back office of the counter: Penjualan (POS sales and their invoices, POS-015 / BIL-001), the
 * dashboard tiles, and Setoran Kas (verifying counter cash, POS-014 / CSH-001). The same boundary
 * rules as `PosService`: caller from the session, owners from the canonical record, permission at
 * that record's scope, and lists scoped in SQL so every page is a full page of visible rows.
 */
@Injectable()
export class CounterBackofficeService implements OnModuleDestroy {
  private readonly pool = createApiPool();

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  context(user: CurrentUserResponse, request: ApiRequest): Promise<CommandContext> {
    return commandContext(this.requirePool(), user, request);
  }

  private async names(context: CommandContext, ids: readonly (string | null)[]) {
    return getUserDisplayNames(this.requirePool(), context.user.organizationId, ids.filter((id): id is string => id !== null));
  }

  async salesList(context: CommandContext, rawQuery: unknown) {
    requireHeldPermission(context, SALES_REPORT);
    const query = parseQuery(PosSalesListQuerySchema, rawQuery);
    const scope = scopeIdsFor(context.assignments, context.user.organizationId, SALES_REPORT, 'WAREHOUSE');
    const { items, total } = await listPosSales(this.requirePool(), {
      organizationId: context.user.organizationId, warehouseIds: scope.ids, allWarehouses: scope.all,
      fromDate: query.from, toDate: query.to, ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(query.cashierUserId ? { cashierUserId: query.cashierUserId } : {}),
      limit: query.pageSize, offset: (query.page - 1) * query.pageSize,
    });
    const names = await this.names(context, items.map((item) => item.cashierUserId));
    return PosSalesListResponseSchema.parse({
      page: query.page, pageSize: query.pageSize, total,
      items: items.map((item) => ({
        saleId: item.saleId, invoiceNumber: item.invoiceNumber, status: item.status, total: item.total,
        checkedOutAt: item.checkedOutAt, paidAt: item.paidAt, handedOverAt: item.handedOverAt, shiftId: item.shiftId,
        cashierUserId: item.cashierUserId, cashierName: names.get(item.cashierUserId) ?? null,
        terminalCode: item.terminalCode, terminalName: item.terminalName,
      })),
    });
  }

  private async reportSale(context: CommandContext, saleId: string, permission: string, isRead: boolean) {
    const scope = inOrganization(context, await getPosSaleScope(this.requirePool(), uuidParam(saleId, 'saleId')));
    authorizeAt(context, permission, scope, isRead);
    // A cart has no invoice and is not yet a sale in this report.
    const item = await getPosSalesListItem(this.requirePool(), scope.id);
    const sale = await getPosSale(this.requirePool(), scope.id);
    if (!item || !sale) throw new DomainError('NOT_FOUND');
    return { item, sale };
  }

  async salesDetail(context: CommandContext, saleId: string) {
    const { item, sale } = await this.reportSale(context, saleId, SALES_REPORT, true);
    const names = await this.names(context, [item.cashierUserId]);
    return PosSalesReportDetailSchema.parse({
      sale, terminalName: item.terminalName, cashierName: names.get(item.cashierUserId) ?? null,
      checkedOutAt: item.checkedOutAt, handedOverAt: item.handedOverAt,
    });
  }

  async invoiceCopy(context: CommandContext, saleId: string, input: PrintPosInvoiceCopyRequest, idempotencyKey: string) {
    const { item } = await this.reportSale(context, saleId, INVOICE_COPY, false);
    return runApiCommand(this.requirePool(), context, 'pos.printInvoiceCopy', idempotencyKey, { saleId: item.saleId, ...input }, async (client) =>
      PosInvoiceCopyResponseSchema.parse(await printPosReceipt(this.requirePool(), client, {
        saleId: item.saleId, printedBy: context.user.id, reprintReason: input.reason, copyOnly: true, ...commandMeta(context),
      })));
  }

  async dashboardSummary(context: CommandContext, rawQuery: unknown) {
    requireHeldPermission(context, SALES_REPORT);
    const query = parseQuery(PosDashboardSummaryQuerySchema, { date: jakartaBusinessDate(), ...(rawQuery as object) });
    const scope = scopeIdsFor(context.assignments, context.user.organizationId, SALES_REPORT, 'WAREHOUSE');
    const sales = await getPosSalesSummary(this.requirePool(), {
      organizationId: context.user.organizationId, warehouseIds: scope.ids, allWarehouses: scope.all, businessDate: query.date,
    });
    // Cash is held per branch; a warehouse-scoped viewer sees the branches of their warehouses.
    const branchIds = scope.all ? [] : await getBranchesOfWarehouses(this.requirePool(), context.user.organizationId, scope.ids);
    const cash = await getUndepositedPosCash(this.requirePool(), { organizationId: context.user.organizationId, branchIds, allBranches: scope.all });
    return PosDashboardSummaryResponseSchema.parse({
      businessDate: query.date, salesTotal: sales.salesTotal, saleCount: sales.saleCount,
      undepositedCash: cash.amount, undepositedPaymentCount: cash.paymentCount,
    });
  }

  async salesTrend(context: CommandContext, rawQuery: unknown) {
    requireHeldPermission(context, SALES_REPORT);
    const query = parseQuery(PosSalesTrendQuerySchema, { to: jakartaBusinessDate(), ...(rawQuery as object) });
    const scope = scopeIdsFor(context.assignments, context.user.organizationId, SALES_REPORT, 'WAREHOUSE');
    const points = await getPosSalesTrend(this.requirePool(), {
      organizationId: context.user.organizationId, warehouseIds: scope.ids, allWarehouses: scope.all, to: query.to, days: query.days,
    });
    return PosSalesTrendResponseSchema.parse({ points });
  }

  private async toHandovers(context: CommandContext, records: CashCustodyRecordView[]): Promise<CashHandover[]> {
    const shifts = await getPosShiftSummaries(this.requirePool(), records.map((record) => record.sourceId).filter((id): id is string => id !== null));
    const names = await this.names(context, records.flatMap((record) => [record.collectorId, record.verifiedBy]));
    return records.map((record) => {
      const shift = record.sourceId ? shifts.get(record.sourceId) : undefined;
      return CashHandoverSchema.parse({
        id: record.id, status: record.status, declaredAmount: record.declaredAmount, countedAmount: record.countedAmount,
        varianceAmount: record.varianceAmount, reasonCode: record.reasonCode, paymentCount: record.paymentCount,
        declaredAt: record.declaredAt, verifiedAt: record.verifiedAt,
        collectorName: names.get(record.collectorId) ?? null, verifierName: record.verifiedBy ? names.get(record.verifiedBy) ?? null : null,
        shift: shift && shift.organizationId === context.user.organizationId ? {
          id: shift.id, terminalName: shift.terminalName, openingFloat: shift.openingFloat, countedCash: shift.countedCash, closeVariance: shift.variance,
        } : null,
      });
    });
  }

  async handoverList(context: CommandContext, rawQuery: unknown) {
    requireHeldPermission(context, CASH_VERIFY);
    const query = parseQuery(CashHandoverListQuerySchema, rawQuery);
    const scope = scopeIdsFor(context.assignments, context.user.organizationId, CASH_VERIFY, 'BRANCH');
    const { items, total } = await listCashCustodyRecords(this.requirePool(), {
      organizationId: context.user.organizationId, branchIds: scope.ids, allBranches: scope.all,
      ...(query.status ? { status: query.status } : {}), limit: query.pageSize, offset: (query.page - 1) * query.pageSize,
    });
    return CashHandoverListResponseSchema.parse({ page: query.page, pageSize: query.pageSize, total, items: await this.toHandovers(context, items) });
  }

  private async handoverRecord(context: CommandContext, id: string, isRead: boolean) {
    const record = inOrganization(context, await getCashCustodyRecord(this.requirePool(), uuidParam(id, 'handoverId')));
    if (!record.branchId) throw new DomainError('NOT_FOUND');
    authorizeAt(context, CASH_VERIFY, { organizationId: record.organizationId, branchId: record.branchId }, isRead);
    return record;
  }

  async handoverDetail(context: CommandContext, id: string) {
    const [handover] = await this.toHandovers(context, [await this.handoverRecord(context, id, true)]);
    return handover;
  }

  /** CSH-001: the verifier is the caller; SOD-06 (not the collector) and the reason rule (MVP-OD-26) live in `payments`. */
  async verifyHandover(context: CommandContext, id: string, input: VerifyCashHandoverRequest, idempotencyKey: string) {
    const record = await this.handoverRecord(context, id, false);
    await runApiCommand(this.requirePool(), context, 'payments.verifyCashHandover', idempotencyKey, { id: record.id, ...input }, (client) =>
      verifyCashCustody(this.requirePool(), client, {
        cashCustodyRecordId: record.id, countedAmount: input.countedAmount, verifiedBy: context.user.id,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), businessDate: jakartaBusinessDate(),
        ...(record.branchId ? { branchId: record.branchId } : {}), requestId: context.requestId, correlationId: context.correlationId,
      }));
    return this.handoverDetail(context, record.id);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

/** Behind the MVP-OD-5 demo switch with the rest of the counter. */
@Controller()
@UseGuards(DemoPosFeatureGuard)
export class CounterBackofficeController {
  constructor(
    @Inject(CounterBackofficeService) private readonly backoffice: CounterBackofficeService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async currentUser(request: ApiRequest) {
    const user = await this.identity.getCurrentUser(request.headers.authorization);
    return this.backoffice.context(user, request);
  }

  @Get('pos/reports/sales')
  async salesList(@Req() request: ApiRequest, @Query() query: Record<string, string>) {
    return this.backoffice.salesList(await this.currentUser(request), query);
  }

  @Get('pos/reports/sales/:id')
  async salesDetail(@Req() request: ApiRequest, @Param('id') saleId: string) {
    return this.backoffice.salesDetail(await this.currentUser(request), saleId);
  }

  @Post('pos/reports/sales/:id/copies')
  async invoiceCopy(@Req() request: ApiRequest, @Param('id') saleId: string, @Body(new ZodValidationPipe(PrintPosInvoiceCopyRequestSchema)) body: PrintPosInvoiceCopyRequest) {
    const key = readIdempotencyKey(request);
    return this.backoffice.invoiceCopy(await this.currentUser(request), saleId, body, key);
  }

  @Get('pos/reports/summary')
  async dashboardSummary(@Req() request: ApiRequest, @Query() query: Record<string, string>) {
    return this.backoffice.dashboardSummary(await this.currentUser(request), query);
  }

  @Get('pos/reports/sales-trend')
  async salesTrend(@Req() request: ApiRequest, @Query() query: Record<string, string>) {
    return this.backoffice.salesTrend(await this.currentUser(request), query);
  }

  @Get('payments/cash-handovers')
  async handoverList(@Req() request: ApiRequest, @Query() query: Record<string, string>) {
    return this.backoffice.handoverList(await this.currentUser(request), query);
  }

  @Get('payments/cash-handovers/:id')
  async handoverDetail(@Req() request: ApiRequest, @Param('id') id: string) {
    return this.backoffice.handoverDetail(await this.currentUser(request), id);
  }

  @Post('payments/cash-handovers/:id/verify')
  async verifyHandover(@Req() request: ApiRequest, @Param('id') id: string, @Body(new ZodValidationPipe(VerifyCashHandoverRequestSchema)) body: VerifyCashHandoverRequest) {
    const key = readIdempotencyKey(request);
    return this.backoffice.verifyHandover(await this.currentUser(request), id, body, key);
  }
}
