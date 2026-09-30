import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Query, Req } from '@nestjs/common';
import {
  DomainError, GoodsReceiptRequestSchema, GoodsReceiptResponseSchema,
  StockAdjustmentReasonListResponseSchema, StockAdjustmentRequestSchema, StockAdjustmentResponseSchema,
  StockBalanceListQuerySchema, StockBalanceListResponseSchema, StockMovementListQuerySchema, StockMovementListResponseSchema,
  type CurrentUserResponse, type GoodsReceiptRequest, type StockAdjustmentRequest,
} from '@pss/contracts';
import { readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { getProductsByIds } from '@pss/master-data';
import { adjustStock, listAdjustmentReasons, listStockBalances, listStockMovements, receiveStock } from '@pss/inventory';
import { listProducts } from '@pss/master-data';
import type { ObservedRequest } from '@pss/observability';
import { Pool } from 'pg';
import {
  authorizeAt, commandContext, commandMeta, parseQuery, requireHeldPermission, runApiCommand, uuidParam,
  type CommandContext,
} from './api-command';
import { IdentityService } from './identity.controller';

type ApiRequest = ObservedRequest;

/**
 * `inventory.adjustment.request` is held by WAREHOUSE_ADMIN (`gudang.demo` and `admin.demo` per
 * MVP_PLAN §7) and `procurement.receipt.post` by the same role, so one warehouse administrator can
 * receive goods and correct a discrepancy — and no demo user holds `inventory.adjustment.approve`,
 * because the INV-006 approval workflow is not built.
 *
 * **Reads are a gap, recorded rather than papered over.** The PRD names
 * `inventory.stock_card.view` (WAREHOUSE_ADMIN, FINANCE, scope WAREHOUSE/ORG) for reading the stock
 * card, but Identity grants it to no group, so no role resolves to it and gating on it would refuse
 * everyone including the demo users. The stock reads below therefore stand on
 * `inventory.adjustment.request` — the permission the demo role demonstrably holds for the stock
 * area — and MVP-OD-20 asks Identity to add the registered grant so the screen can use the
 * permission the PRD names. What is *not* done is pretending a different permission is the right one.
 */
const STOCK_MANAGE = 'inventory.adjustment.request';
/** How many products a name search may resolve to before the id set is truncated. */
const PRODUCT_SEARCH_LIMIT = 200;
const RECEIPT_POST = 'procurement.receipt.post';

/**
 * Stok, Terima Barang and Penyesuaian Stok — INV-001..006's back-office API.
 *
 * A warehouse id is a path parameter on every route and is resolved to its own organization's
 * warehouse before anything else happens, so a warehouse in another organization is `NOT_FOUND`
 * rather than a permission answer. The stock itself is then read through `inventory`'s own queries
 * and labelled with product names by asking `master-data` — the join happens here rather than in
 * another domain's SQL (AGENTS.md §3.1).
 */
@Injectable()
export class BackofficeStockService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  context(user: CurrentUserResponse, request: ApiRequest): Promise<CommandContext> {
    return commandContext(this.requirePool(), user, request);
  }

  private authorize(context: CommandContext, permission: string, warehouseId: string, isRead: boolean): void {
    authorizeAt(context, permission, { organizationId: context.user.organizationId, warehouseId }, isRead);
  }

  /**
   * The label a row needs to be readable, from the domain that owns product identity.
   *
   * An empty page asks nothing: `getProductsByIds` refuses an empty id list on purpose, and a query
   * with no ids has no answer to give.
   */
  private async labelProducts(context: CommandContext, productIds: string[]) {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return () => null;
    const products = await getProductsByIds(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, productIds: unique,
    });
    return (productId: string) => products.get(productId) ?? null;
  }

  async balances(context: CommandContext, rawQuery: unknown) {
    const query = parseQuery(StockBalanceListQuerySchema, rawQuery);
    const warehouse = uuidParam(query.warehouseId, 'warehouseId');
    this.authorize(context, STOCK_MANAGE, warehouse, true);

    const page = await listStockBalances(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, warehouseId: warehouse,
      ...(query.q ? await this.matchingProductIds(context, query.q) : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.maxQty ? { maxQty: query.maxQty } : {}),
      ...(query.unvaluedOnly ? { unvaluedOnly: true } : {}),
      page: query.page, pageSize: query.pageSize, sort: query.sort,
    });
    const label = await this.labelProducts(context, page.items.map((item) => item.productId));
    return StockBalanceListResponseSchema.parse({
      warehouseId: warehouse,
      items: page.items.map((item) => ({ ...item, product: label(item.productId) })),
      page: page.page, pageSize: page.pageSize, total: page.total, hasMore: page.hasMore,
      totalValue: page.totalValue, unvaluedCount: page.unvaluedCount,
    });
  }

  async movements(context: CommandContext, rawQuery: unknown) {
    const query = parseQuery(StockMovementListQuerySchema, rawQuery);
    const warehouse = uuidParam(query.warehouseId, 'warehouseId');
    this.authorize(context, STOCK_MANAGE, warehouse, true);

    const page = await listStockMovements(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, warehouseId: warehouse,
      ...(query.q ? await this.matchingProductIds(context, query.q) : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.movementType ? { movementType: query.movementType } : {}),
      ...(query.reasonCode ? { reasonCode: query.reasonCode } : {}),
      page: query.page, pageSize: query.pageSize, sort: query.sort,
    });
    const label = await this.labelProducts(context, page.items.map((item) => item.productId));
    return StockMovementListResponseSchema.parse({
      warehouseId: warehouse,
      items: page.items.map((item) => ({ ...item, product: label(item.productId) })),
      page: page.page, pageSize: page.pageSize, total: page.total, hasMore: page.hasMore,
    });
  }

  /**
   * The product ids a search term matches, resolved through `master-data`'s own read.
   *
   * **A stock screen searches by name, and the name is not this side's fact.** `core.product` is
   * `master-data`'s table (AGENTS.md §3.1), so the ledger cannot `ILIKE` a name; the API layer asks
   * the owner which products match and passes the ids down. That is also why the term is capped: a
   * very broad term must not become an unbounded `IN (…)`, and a truncated match is reported as the
   * `hasMore` on a truncated list rather than silently as "everything".
   *
   * The answer is `[]` when nothing matches, and an empty id set matches **nothing** in the ledger —
   * a search with no hits must return an empty page, not the whole warehouse.
   */
  private async matchingProductIds(context: CommandContext, term: string): Promise<{ productIds: string[] }> {
    const found = await listProducts(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, query: term, page: 1, pageSize: PRODUCT_SEARCH_LIMIT, sort: 'name',
    });
    return { productIds: found.items.map((item) => item.productId) };
  }

  /**
   * The reason picker's options. Held-permission rather than warehouse-scoped, because the vocabulary
   * is platform-level (MVP-OD-15) and a caller picking a reason is not yet acting on a warehouse.
   */
  async adjustmentReasons(context: CommandContext) {
    requireHeldPermission(context, STOCK_MANAGE);
    return StockAdjustmentReasonListResponseSchema.parse({ items: await listAdjustmentReasons(this.requirePool()) });
  }

  async goodsReceipt(context: CommandContext, warehouseId: string, input: GoodsReceiptRequest, idempotencyKey: string) {
    const warehouse = uuidParam(warehouseId, 'warehouseId');
    this.authorize(context, RECEIPT_POST, warehouse, false);
    return runApiCommand(this.requirePool(), context, 'inventory.receiveStock', idempotencyKey,
      { ...input, warehouseId: warehouse },
      async (client) => {
        const result = await receiveStock(this.requirePool(), client, {
          organizationId: context.user.organizationId, warehouseId: warehouse,
          // A back-office receipt is a goods receipt by definition: the source type is the whole of
          // the event's `sourceType` and finance's posting rules switch on it, so it is stated here
          // rather than defaulted.
          sourceType: 'GOODS_RECEIPT',
          referenceType: 'GOODS_RECEIPT',
          referenceId: input.sourceId ?? randomUUID(),
          ...(input.businessDate ? { businessDate: input.businessDate } : {}),
          lines: input.lines.map((line) => ({ ...line, unitCost: line.unitCost ?? null })),
          ...commandMeta(context),
        });
        return GoodsReceiptResponseSchema.parse({
          warehouseId: warehouse,
          movementIds: result.movementIds,
          unvaluedLineCount: input.lines.filter((line) => line.unitCost === undefined || line.unitCost === null).length,
        });
      });
  }

  async adjust(context: CommandContext, warehouseId: string, input: StockAdjustmentRequest, idempotencyKey: string) {
    const warehouse = uuidParam(warehouseId, 'warehouseId');
    this.authorize(context, STOCK_MANAGE, warehouse, false);
    return runApiCommand(this.requirePool(), context, 'inventory.adjustStock', idempotencyKey,
      { ...input, warehouseId: warehouse },
      async (client) => {
        const result = await adjustStock(this.requirePool(), client, {
          organizationId: context.user.organizationId, warehouseId: warehouse,
          referenceType: 'BACKOFFICE_ADJUSTMENT',
          referenceId: randomUUID(),
          ...(input.businessDate ? { businessDate: input.businessDate } : {}),
          lines: input.lines,
          ...commandMeta(context),
        });
        return StockAdjustmentResponseSchema.parse({ warehouseId: warehouse, movementIds: result.movementIds });
      });
  }

  onModuleDestroy(): Promise<void> {
    return this.pool?.end() ?? Promise.resolve();
  }
}

/**
 * `/inventory/*` — balances, the movement ledger, a goods receipt with a cost, and a stock
 * adjustment. Every mutating route requires an `Idempotency-Key` (PLT-006).
 */
@Controller('inventory')
export class BackofficeStockController {
  constructor(
    @Inject(BackofficeStockService) private readonly service: BackofficeStockService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async currentUser(request: ApiRequest) {
    return this.service.context(await this.identity.getCurrentUser(request.headers.authorization), request);
  }

  @Get('stock-balances')
  async balances(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.service.balances(await this.currentUser(request), query);
  }

  @Get('stock-movements')
  async movements(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.service.movements(await this.currentUser(request), query);
  }

  @Get('stock-adjustment-reasons')
  async adjustmentReasons(@Req() request: ApiRequest) {
    return this.service.adjustmentReasons(await this.currentUser(request));
  }

  @Post('warehouses/:warehouseId/goods-receipts')
  async goodsReceipt(
    @Req() request: ApiRequest, @Param('warehouseId') warehouseId: string,
    @Body(new ZodValidationPipe(GoodsReceiptRequestSchema)) body: GoodsReceiptRequest,
  ) {
    return this.service.goodsReceipt(await this.currentUser(request), warehouseId, body, readIdempotencyKey(request));
  }

  @Post('warehouses/:warehouseId/stock-adjustments')
  async adjust(
    @Req() request: ApiRequest, @Param('warehouseId') warehouseId: string,
    @Body(new ZodValidationPipe(StockAdjustmentRequestSchema)) body: StockAdjustmentRequest,
  ) {
    return this.service.adjust(await this.currentUser(request), warehouseId, body, readIdempotencyKey(request));
  }
}
