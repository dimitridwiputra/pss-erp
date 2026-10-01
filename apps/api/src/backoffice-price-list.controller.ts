import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  ActivateDraftPriceListResponseSchema, CreateDraftPriceListRequestSchema, CreateDraftPriceListResponseSchema, DomainError,
  PriceListItemEnrichedResponseSchema, PriceListItemListQuerySchema, PriceListQuerySchema, PriceListResponseSchema,
  SetPriceListItemRequestSchema, SetPriceListItemResponseSchema,
  type CreateDraftPriceListRequest, type CurrentUserResponse, type SetPriceListItemRequest,
} from '@pss/contracts';
import {
  activateDraftPriceList, createDraftPriceList, listPriceListItems, listPriceLists, setPriceListItem,
} from '@pss/commercial';
import { readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { getProductsByIds } from '@pss/master-data';
import type { ObservedRequest } from '@pss/observability';
import { Pool } from 'pg';
import { createApiPool } from './database-pool';
import {
  authorizeAt, commandContext, commandMeta, parseQuery, runApiCommand, uuidParam, type CommandContext,
} from './api-command';
import { IdentityService } from './identity.controller';

type ApiRequest = ObservedRequest;

/**
 * `commercial.price_list.manage` is held by COMMERCIAL_ADMIN at the organization (`admin.demo` per
 * MVP_PLAN §7). Price lists are organization-scoped, so the resource is the caller's own organization
 * and a warehouse-scoped assignment of the same role does not match.
 *
 * **No approval step.** COM-001 requires a `price_list_activation` approval before a list goes live
 * and rejects proposer = approver; this API activates directly and records that as MVP-OD-14. The
 * endpoint is named `activation` rather than `approve` so nobody reading a log mistakes the demo's
 * direct activation for the PRD's control.
 */
const PRICE_MANAGE = 'commercial.price_list.manage';

/**
 * Harga — the price list screen's API (COM-001).
 *
 * The flow is version-based, because COM-001.BR02 makes an edit in place illegal: `createDraft` copies
 * the live list, `setItem` writes into the draft, and `activation` publishes it. `listItems` shows
 * either the draft being edited or the live list, and labels each row with the product's SKU and name
 * by asking `master-data` — `core.product` is that domain's table, so the join is composed here
 * (AGENTS.md §3.1).
 */
@Injectable()
export class BackofficePriceListService implements OnModuleDestroy {
  // `createApiPool`, not a bare `new Pool`: without the pool's `error` listener an idle
  // connection cut by a database restart is an unhandled event and takes the process down.
  private readonly pool = createApiPool();

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  context(user: CurrentUserResponse, request: ApiRequest): Promise<CommandContext> {
    return commandContext(this.requirePool(), user, request);
  }

  private authorize(context: CommandContext, isRead: boolean): void {
    authorizeAt(context, PRICE_MANAGE, { organizationId: context.user.organizationId }, isRead);
  }

  async list(context: CommandContext, rawQuery: unknown) {
    this.authorize(context, true);
    const query = parseQuery(PriceListQuerySchema, rawQuery);
    const page = await listPriceLists(this.requirePool(), undefined, {
      organizationId: context.user.organizationId,
      ...(query.scope ? { scope: query.scope } : {}),
      page: query.page, pageSize: query.pageSize,
    });
    return PriceListResponseSchema.parse({
      items: page.items.map((item) => ({
        priceListId: item.priceListId, scope: item.scope,
        status: item.status as 'DRAFT' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED',
        version: item.version, validFrom: item.validFrom, itemCount: item.itemCount, createdAt: item.createdAt,
      })),
      page: page.page, pageSize: page.pageSize, total: page.total, hasMore: page.hasMore,
      activePriceListId: page.activePriceListId,
    });
  }

  async items(context: CommandContext, priceListId: string, rawQuery: unknown) {
    this.authorize(context, true);
    const id = uuidParam(priceListId, 'priceListId');
    const query = parseQuery(PriceListItemListQuerySchema, rawQuery);
    const page = await listPriceListItems(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, priceListId: id,
      ...(query.q ? { query: query.q } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      page: query.page, pageSize: query.pageSize, sort: query.sort,
    });
    const products = await getProductsByIds(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, productIds: page.items.map((item) => item.productId),
    });
    return PriceListItemEnrichedResponseSchema.parse({
      priceListId: page.priceListId,
      status: page.status as 'DRAFT' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED',
      version: page.version, validFrom: page.validFrom,
      items: page.items.map((item) => ({ ...item, product: products.get(item.productId) ?? null })),
      page: page.page, pageSize: page.pageSize, total: page.total, hasMore: page.hasMore,
    });
  }

  async createDraft(context: CommandContext, input: CreateDraftPriceListRequest, idempotencyKey: string) {
    this.authorize(context, false);
    return runApiCommand(this.requirePool(), context, 'commercial.createDraftPriceList', idempotencyKey, input,
      async (client) => CreateDraftPriceListResponseSchema.parse(await createDraftPriceList(this.requirePool(), client, {
        organizationId: context.user.organizationId, scope: input.scope, validFrom: input.validFrom,
        ...(input.copyFromPriceListId ? { copyFromPriceListId: input.copyFromPriceListId } : {}),
        ...commandMeta(context),
      })));
  }

  async setItem(context: CommandContext, priceListId: string, input: SetPriceListItemRequest, idempotencyKey: string) {
    this.authorize(context, false);
    const id = uuidParam(priceListId, 'priceListId');
    return runApiCommand(this.requirePool(), context, 'commercial.setPriceListItem', idempotencyKey,
      { priceListId: id, ...input },
      async (client) => SetPriceListItemResponseSchema.parse(await setPriceListItem(this.requirePool(), client, {
        organizationId: context.user.organizationId, priceListId: id,
        productId: input.productId, uom: input.uom, unitPrice: input.unitPrice,
        ...commandMeta(context),
      })));
  }

  async activate(context: CommandContext, priceListId: string, idempotencyKey: string) {
    this.authorize(context, false);
    const id = uuidParam(priceListId, 'priceListId');
    return runApiCommand(this.requirePool(), context, 'commercial.activateDraftPriceList', idempotencyKey,
      { priceListId: id },
      async (client) => ActivateDraftPriceListResponseSchema.parse(await activateDraftPriceList(this.requirePool(), client, {
        organizationId: context.user.organizationId, priceListId: id, ...commandMeta(context),
      })));
  }

  onModuleDestroy(): Promise<void> {
    return this.pool?.end() ?? Promise.resolve();
  }
}

/**
 * `/commercial/price-lists/*` — the versions of a scope, their prices, and activation. Every
 * mutating route requires an `Idempotency-Key` (PLT-006), and activation is idempotent by
 * construction: a list that is no longer DRAFT is `INVALID_STATE_TRANSITION`, so a retried press
 * cannot publish it twice.
 */
@Controller('commercial/price-lists')
export class BackofficePriceListController {
  constructor(
    @Inject(BackofficePriceListService) private readonly service: BackofficePriceListService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async currentUser(request: ApiRequest) {
    return this.service.context(await this.identity.getCurrentUser(request.headers.authorization), request);
  }

  @Get()
  async list(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.service.list(await this.currentUser(request), query);
  }

  @Post()
  async createDraft(
    @Req() request: ApiRequest,
    @Body(new ZodValidationPipe(CreateDraftPriceListRequestSchema)) body: CreateDraftPriceListRequest,
  ) {
    return this.service.createDraft(await this.currentUser(request), body, readIdempotencyKey(request));
  }

  @Get(':id/items')
  async items(@Req() request: ApiRequest, @Param('id') priceListId: string, @Query() query: Record<string, unknown>) {
    return this.service.items(await this.currentUser(request), priceListId, query);
  }

  @Put(':id/items')
  async setItem(
    @Req() request: ApiRequest, @Param('id') priceListId: string,
    @Body(new ZodValidationPipe(SetPriceListItemRequestSchema)) body: SetPriceListItemRequest,
  ) {
    return this.service.setItem(await this.currentUser(request), priceListId, body, readIdempotencyKey(request));
  }

  @Post(':id/activation')
  async activate(@Req() request: ApiRequest, @Param('id') priceListId: string) {
    return this.service.activate(await this.currentUser(request), priceListId, readIdempotencyKey(request));
  }
}
