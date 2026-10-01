import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  AddProductBarcodeRequestSchema, AddProductUomRequestSchema, CreateProductRequestSchema, CustomerListQuerySchema,
  CustomerListResponseSchema, DomainError, ProductDetailSchema, ProductListQuerySchema, ProductListResponseSchema,
  ProductBarcodeResponseSchema, ProductUomResponseSchema, UpdateProductRequestSchema, UpdateProductResponseSchema,
  type AddProductBarcodeRequest, type AddProductUomRequest, type CreateProductRequest, type CurrentUserResponse,
  type UpdateProductRequest,
} from '@pss/contracts';
import { readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  addProductBarcode, addProductUom, createProduct, getProduct, getProductsByIds, listCustomers, listProducts, updateProduct,
} from '@pss/master-data';
import type { ObservedRequest } from '@pss/observability';
import {
  authorizeAt, commandContext, commandMeta, parseQuery, runApiCommand, uuidParam, type CommandContext,
} from './api-command';
import { IdentityService } from './identity.controller';

type ApiRequest = ObservedRequest;

/**
 * `master_data.product.manage` is the only product permission registered, and MVP-OD-32's demo default
 * grants it to MASTER_DATA_STEWARD at the organization (`admin.demo`). It gates writes and reads
 * alike: no `master_data.product.view` exists, so a read stands on the same grant rather than
 * inventing a second one (MVP-OD-20). A warehouse-scoped assignment of the same role does not match
 * an organization-scoped resource, so a warehouse steward cannot edit the whole catalog.
 */
const PRODUCT_MANAGE = 'master_data.product.manage';

const ProductSummaryQuerySchema = z.strictObject({
  /** Comma-separated, so a caller that already holds ids can resolve them in one request. */
  productIds: z.string().min(1).transform((raw) => [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))])
    .pipe(z.array(z.uuid()).min(1).max(200)),
});
const ProductSummarySchema = z.strictObject({ productId: z.uuid(), sku: z.string(), name: z.string(), baseUom: z.string() });
const ProductSummaryListResponseSchema = z.strictObject({ items: z.array(ProductSummarySchema) });

/**
 * Barang and Pelanggan — the Data Utama screens' API (MDM-001..004).
 *
 * Each route does the same four things `PosService` does and nothing more: the caller comes from the
 * session, a supplied id is resolved to its canonical owner inside `master-data`, the permission is
 * checked at that owner, and a mutation runs through `runApiCommand` under the caller's
 * `Idempotency-Key`. This service is the API boundary; every rule lives in `@pss/master-data`.
 *
 * The organization is always the caller's own — read from the session, never from a parameter — so
 * there is no organization to validate and no way to address another one's products or customers.
 * Ownership is therefore established by the query's own `organization_id` filter: a product in
 * another organization comes back `NOT_FOUND`, which is also the right answer for an id that does not
 * exist.
 */
@Injectable()
export class BackofficeProductService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  context(user: CurrentUserResponse, request: ApiRequest): Promise<CommandContext> {
    return commandContext(this.requirePool(), user, request);
  }

  private authorize(context: CommandContext, isRead: boolean): void {
    authorizeAt(context, PRODUCT_MANAGE, { organizationId: context.user.organizationId }, isRead);
  }

  /** Resolve a product id to a product of the caller's own organization, or NOT_FOUND. */
  private async ownedProduct(context: CommandContext, productId: string) {
    const id = uuidParam(productId, 'productId');
    return getProduct(this.requirePool(), undefined, { organizationId: context.user.organizationId, productId: id });
  }

  async list(context: CommandContext, rawQuery: unknown) {
    this.authorize(context, true);
    const query = parseQuery(ProductListQuerySchema, rawQuery);
    const page = await listProducts(this.requirePool(), undefined, {
      organizationId: context.user.organizationId,
      ...(query.q ? { query: query.q } : {}),
      ...(query.status ? { status: query.status } : {}),
      page: query.page, pageSize: query.pageSize, sort: query.sort,
    });
    return ProductListResponseSchema.parse({
      items: page.items.map((item) => ({
        productId: item.productId, sku: item.sku, name: item.name, baseUom: item.baseUom,
        status: item.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE',
        unitCount: item.unitCount, hasBarcode: item.hasBarcode, createdAt: item.createdAt,
      })),
      page: page.page, pageSize: page.pageSize, total: page.total, hasMore: page.hasMore,
    });
  }

  async detail(context: CommandContext, productId: string) {
    this.authorize(context, true);
    return ProductDetailSchema.parse(await this.ownedProduct(context, productId));
  }

  async create(context: CommandContext, input: CreateProductRequest, idempotencyKey: string) {
    this.authorize(context, false);
    return runApiCommand(this.requirePool(), context, 'masterData.createProduct', idempotencyKey, input, async (client) => {
      const created = await createProduct(this.requirePool(), client, {
        organizationId: context.user.organizationId,
        sku: input.sku, name: input.name, baseUom: input.baseUom,
        ...(input.orderCapture ? { orderCapture: input.orderCapture } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...commandMeta(context),
      });
      // Answer with the product as it now stands, base unit included, so the screen does not have to
      // ask again before showing the form it just submitted.
      return ProductDetailSchema.parse(await getProduct(this.requirePool(), client, {
        organizationId: context.user.organizationId, productId: created.productId,
      }));
    });
  }

  async update(context: CommandContext, productId: string, input: UpdateProductRequest, idempotencyKey: string) {
    const owned = await this.ownedProduct(context, productId);
    this.authorize(context, false);
    return runApiCommand(this.requirePool(), context, 'masterData.updateProduct', idempotencyKey,
      { productId: owned.productId, ...input },
      async (client) => UpdateProductResponseSchema.parse(await updateProduct(this.requirePool(), client, {
        organizationId: context.user.organizationId, productId: owned.productId,
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.baseUom ? { baseUom: input.baseUom } : {}),
        ...(input.orderCapture ? { orderCapture: input.orderCapture } : {}),
        ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
        ...commandMeta(context),
      })));
  }

  async addBarcode(context: CommandContext, productId: string, input: AddProductBarcodeRequest, idempotencyKey: string) {
    const owned = await this.ownedProduct(context, productId);
    this.authorize(context, false);
    return runApiCommand(this.requirePool(), context, 'masterData.addProductBarcode', idempotencyKey,
      { productId: owned.productId, ...input },
      async (client) => ProductBarcodeResponseSchema.parse(await addProductBarcode(this.requirePool(), client, {
        organizationId: context.user.organizationId, productId: owned.productId,
        barcode: input.barcode, uom: input.uom, ...commandMeta(context),
      })));
  }

  async addUom(context: CommandContext, productId: string, input: AddProductUomRequest, idempotencyKey: string) {
    const owned = await this.ownedProduct(context, productId);
    this.authorize(context, false);
    return runApiCommand(this.requirePool(), context, 'masterData.addProductUom', idempotencyKey,
      { productId: owned.productId, ...input },
      async (client) => ProductUomResponseSchema.parse(await addProductUom(this.requirePool(), client, {
        organizationId: context.user.organizationId, productId: owned.productId,
        uom: input.uom, conversionFactor: input.conversionFactor, ...commandMeta(context),
      })));
  }

  /**
   * Pelanggan, read-only. It lives on this controller because it is the other half of the Data Utama
   * screen, not because customers and products share a table: the query is `master-data`'s and reads
   * `core.customer` alone.
   *
   * Gated on the same steward grant as the product screens, and that is a gap rather than a design:
   * no customer permission is registered and MVP-OD-32 deliberately left every master-data resource
   * except the product ungranted (MVP-OD-21).
   */
  async customers(context: CommandContext, rawQuery: unknown) {
    this.authorize(context, true);
    const query = parseQuery(CustomerListQuerySchema, rawQuery);
    const page = await listCustomers(this.requirePool(), undefined, {
      organizationId: context.user.organizationId,
      ...(query.q ? { query: query.q } : {}),
      ...(query.status ? { status: query.status } : {}),
      page: query.page, pageSize: query.pageSize, sort: query.sort,
    });
    return CustomerListResponseSchema.parse({
      items: page.items.map((item) => ({
        customerId: item.customerId, code: item.code, name: item.name, phone: item.phone,
        segment: item.segment, status: item.status as 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'INACTIVE' | 'MERGED',
        isWalkIn: item.isWalkIn, createdAt: item.createdAt,
      })),
      page: page.page, pageSize: page.pageSize, total: page.total, hasMore: page.hasMore,
    });
  }

  /**
   * Products a caller already holds ids for, so a page of prices or stock rows can be labelled with
   * SKU and name in one extra request instead of one per row. The join happens here, at the API
   * layer, because `core.product` is `master-data`'s table (AGENTS.md §3.1).
   */
  async summaries(context: CommandContext, rawQuery: unknown) {
    this.authorize(context, true);
    const query = parseQuery(ProductSummaryQuerySchema, rawQuery);
    const products = await getProductsByIds(this.requirePool(), undefined, {
      organizationId: context.user.organizationId, productIds: query.productIds,
    });
    return ProductSummaryListResponseSchema.parse({ items: [...products.values()] });
  }

  onModuleDestroy(): Promise<void> {
    return this.pool?.end() ?? Promise.resolve();
  }
}

/**
 * `/master-data/*` — the product master and the customer list. No demo switch here: these are
 * back-office data, not the counter, and MVP-OD-5's switch is about the POS endpoints. Every
 * mutating route requires an `Idempotency-Key` (PLT-006).
 */
@Controller('master-data')
export class BackofficeProductController {
  constructor(
    @Inject(BackofficeProductService) private readonly service: BackofficeProductService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async currentUser(request: ApiRequest) {
    return this.service.context(await this.identity.getCurrentUser(request.headers.authorization), request);
  }

  @Get('products')
  async list(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.service.list(await this.currentUser(request), query);
  }

  @Post('products')
  async create(
    @Req() request: ApiRequest,
    @Body(new ZodValidationPipe(CreateProductRequestSchema)) body: CreateProductRequest,
  ) {
    return this.service.create(await this.currentUser(request), body, readIdempotencyKey(request));
  }

  @Get('products/:id')
  async detail(@Req() request: ApiRequest, @Param('id') productId: string) {
    return this.service.detail(await this.currentUser(request), productId);
  }

  @Put('products/:id')
  async update(
    @Req() request: ApiRequest, @Param('id') productId: string,
    @Body(new ZodValidationPipe(UpdateProductRequestSchema)) body: UpdateProductRequest,
  ) {
    return this.service.update(await this.currentUser(request), productId, body, readIdempotencyKey(request));
  }

  @Post('products/:id/barcodes')
  async addBarcode(
    @Req() request: ApiRequest, @Param('id') productId: string,
    @Body(new ZodValidationPipe(AddProductBarcodeRequestSchema)) body: AddProductBarcodeRequest,
  ) {
    return this.service.addBarcode(await this.currentUser(request), productId, body, readIdempotencyKey(request));
  }

  @Post('products/:id/uoms')
  async addUom(
    @Req() request: ApiRequest, @Param('id') productId: string,
    @Body(new ZodValidationPipe(AddProductUomRequestSchema)) body: AddProductUomRequest,
  ) {
    return this.service.addUom(await this.currentUser(request), productId, body, readIdempotencyKey(request));
  }

  @Get('customers')
  async customers(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.service.customers(await this.currentUser(request), query);
  }

  @Get('product-summaries')
  async summaries(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.service.summaries(await this.currentUser(request), query);
  }
}
