import { Body, Controller, Delete, Get, Inject, Injectable, OnModuleDestroy, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  AcceptPosTenderRequestSchema, AcceptPosTenderResponseSchema, AddPosSaleLineRequestSchema, AddPosSaleLineResponseSchema,
  CheckoutPosSaleResponseSchema, ClosePosShiftRequestSchema, ConfirmPosPickupHandoverRequestSchema,
  ConfirmPosPickupHandoverResponseSchema, CreatePosSaleRequestSchema, DeclarePosCashHandoverResponseSchema, DomainError,
  KasirKatalogResponseSchema, KasirScanResponseSchema, KasirShiftSayaResponseSchema, KasirTerminalListResponseSchema,
  OpenPosShiftRequestSchema, PosCartTotalResponseSchema, PosPickupListResponseSchema, PosReceiptResponseSchema,
  PosSaleResponseSchema, PosShiftResponseSchema, PrintPosReceiptRequestSchema, UpdatePosSaleLineRequestSchema,
  type AcceptPosTenderRequest, type AddPosSaleLineRequest, type ClosePosShiftRequest, type ConfirmPosPickupHandoverRequest,
  type CreatePosSaleRequest, type CurrentUserResponse, type OpenPosShiftRequest, type PrintPosReceiptRequest,
  type UpdatePosSaleLineRequest,
} from '@pss/contracts';
import { readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { findProductByBarcode, searchProducts } from '@pss/master-data';
import { resolvePrice } from '@pss/commercial';
import type { ObservedRequest } from '@pss/observability';
import {
  acceptPosTender, addPosSaleLine, checkoutPosSale, closePosShift, confirmPosPickupHandover, createPosSale,
  declarePosCashHandover, getPosSale, getPosSaleScope, getPosShiftScope, getPosTerminalScope, getShiftSaya,
  listPickupsAwaitingHandover, listPosTerminals, openPosShift, printPosReceipt, removePosSaleLine, updatePosSaleLine,
  type PosSaleScope, type PosShiftScope,
} from '@pss/pos';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {
  authorizeAt, canAt, commandContext, commandMeta, inOrganization, requireHeldPermission, runApiCommand, uuidParam,
  type CommandContext, type Scoped,
} from './api-command';
import { DemoPosFeatureGuard } from './demo-pos-guard';
import { IdentityService } from './identity.controller';

type ApiRequest = ObservedRequest;

/** Price list scope is a config value (PLT-009) not yet wired; a single default is used until then. */
const DEFAULT_PRICE_LIST_SCOPE = 'KONTER';

/**
 * Every POS rule lives in `@pss/pos` and the domains it calls. This service is the API boundary
 * only, and each route does the same four things in order (RBAC-002, PLT-006, Appendix L.3–L.4):
 *
 *   1. resolve the caller from the session, never from the body;
 *   2. resolve the canonical owner of every supplied id through a `@pss/pos` scope query — an id
 *      from another organization is `NOT_FOUND`, so its existence is not disclosed;
 *   3. check the Appendix D permission at that record's warehouse scope, and for cashier work,
 *      that the shift is the caller's own (POS_CASHIER scope "WAREHOUSE + OWN (shift)");
 *   4. run the command through `runCommand` under the caller's `Idempotency-Key`, so the
 *      mutation, its audit entry and its outbox events commit once, and a retry replays.
 */
@Injectable()
export class PosService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  async context(user: CurrentUserResponse, request: ApiRequest): Promise<CommandContext> {
    return commandContext(this.requirePool(), user, request);
  }

  private meta(context: CommandContext) { return commandMeta(context); }
  private inOrganization<T extends { organizationId: string }>(context: CommandContext, record: T | null): T { return inOrganization(context, record); }
  private authorize(context: CommandContext, permission: string, scope: Scoped, isRead = false): void { authorizeAt(context, permission, scope, isRead); }
  private canAt(context: CommandContext, permission: string, scope: Scoped): boolean { return canAt(context, permission, scope); }
  private requireHeldPermission(context: CommandContext, permission: string): void { requireHeldPermission(context, permission); }

  private async shiftScope(context: CommandContext, shiftId: string): Promise<PosShiftScope> {
    return this.inOrganization(context, await getPosShiftScope(this.requirePool(), uuidParam(shiftId, 'shiftId')));
  }

  private async saleScope(context: CommandContext, saleId: string): Promise<PosSaleScope> {
    return this.inOrganization(context, await getPosSaleScope(this.requirePool(), uuidParam(saleId, 'saleId')));
  }

  /** POS-000 own-shift rule: a cashier works only on the shift they opened. */
  private requireOwnShift(context: CommandContext, cashierUserId: string): void {
    if (cashierUserId !== context.user.id) throw new DomainError('PERMISSION_DENIED');
  }

  private async command<T>(
    context: CommandContext, commandName: string, idempotencyKey: string, requestBody: unknown,
    execute: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return runApiCommand(this.requirePool(), context, commandName, idempotencyKey, requestBody, execute);
  }

  async terminals(context: CommandContext) {
    const terminals = await listPosTerminals(this.requirePool(), context.user.organizationId);
    return KasirTerminalListResponseSchema.parse({
      items: terminals
        .filter((terminal) => this.canAt(context, 'pos.shift.open', terminal))
        .map((terminal) => ({
          id: terminal.id, branchId: terminal.branchId, warehouseId: terminal.warehouseId, code: terminal.code,
          name: terminal.name, status: terminal.status, inUse: terminal.inUse,
        })),
    });
  }

  async openShift(context: CommandContext, input: OpenPosShiftRequest, idempotencyKey: string) {
    const terminal = this.inOrganization(context, await getPosTerminalScope(this.requirePool(), input.terminalId));
    this.authorize(context, 'pos.shift.open', terminal);
    return this.command(context, 'pos.openShift', idempotencyKey, input, async (client) => {
      const shift = await openPosShift(this.requirePool(), client, {
        organizationId: terminal.organizationId, terminalId: terminal.id, cashierUserId: context.user.id,
        openingFloat: input.openingFloat, ...this.meta(context),
      });
      return PosShiftResponseSchema.parse({
        id: shift.id, terminalId: shift.terminalId, status: shift.status, openingFloat: shift.openingFloat,
        expectedCash: null, countedCash: null, variance: null,
      });
    });
  }

  async closeShift(context: CommandContext, shiftId: string, input: ClosePosShiftRequest, idempotencyKey: string) {
    const shift = await this.shiftScope(context, shiftId);
    this.authorize(context, 'pos.shift.close', shift);
    this.requireOwnShift(context, shift.cashierUserId);
    return this.command(context, 'pos.closeShift', idempotencyKey, { shiftId: shift.id, ...input }, async (client) => {
      const closed = await closePosShift(this.requirePool(), client, { shiftId: shift.id, ...input, ...this.meta(context) });
      return PosShiftResponseSchema.parse({
        id: closed.id, terminalId: shift.terminalId, status: closed.status, openingFloat: closed.openingFloat,
        expectedCash: closed.expectedCash, countedCash: closed.countedCash, variance: closed.variance,
      });
    });
  }

  async declareCashHandover(context: CommandContext, shiftId: string, idempotencyKey: string) {
    const shift = await this.shiftScope(context, shiftId);
    this.authorize(context, 'payments.cash_handover.declare', shift);
    this.requireOwnShift(context, shift.cashierUserId);
    return this.command(context, 'pos.declareCashHandover', idempotencyKey, { shiftId: shift.id }, async (client) =>
      DeclarePosCashHandoverResponseSchema.parse(await declarePosCashHandover(this.requirePool(), client, { shiftId: shift.id, ...this.meta(context) })));
  }

  async shiftSaya(context: CommandContext) {
    this.requireHeldPermission(context, 'pos.shift.open');
    return KasirShiftSayaResponseSchema.parse(await getShiftSaya(this.requirePool(), context.user.id));
  }

  async katalog(context: CommandContext, query: string) {
    this.requireHeldPermission(context, 'pos.sale.create');
    const parsed = z.string().trim().min(2).max(100).safeParse(query);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', [], [{ path: 'q', code: 'too_small', message: 'Ketik minimal 2 huruf.' }]);
    const items = await searchProducts(this.requirePool(), { organizationId: context.user.organizationId, query: parsed.data, limit: 20 });
    return KasirKatalogResponseSchema.parse({ items: items.filter((item) => item.status === 'ACTIVE') });
  }

  async scan(context: CommandContext, barcode: string) {
    this.requireHeldPermission(context, 'pos.sale.create');
    const parsed = z.string().trim().min(1).max(64).safeParse(barcode);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', [], [{ path: 'barcode', code: 'invalid_format', message: 'Periksa barcode.' }]);
    const match = await findProductByBarcode(this.requirePool(), { organizationId: context.user.organizationId, barcode: parsed.data });
    if (!match) throw new DomainError('NOT_FOUND');
    if (match.orderCapture !== 'PSS' || match.status !== 'ACTIVE') throw new DomainError('POS_SKU_NOT_SELLABLE');
    const price = await resolvePrice(this.requirePool(), {
      organizationId: context.user.organizationId, productId: match.productId, uom: match.uom, priceListScope: DEFAULT_PRICE_LIST_SCOPE,
    });
    return KasirScanResponseSchema.parse({
      productId: match.productId, sku: match.sku, name: match.name, uom: match.uom, unitPrice: price.unitPrice, qtyAvailable: null,
    });
  }

  async createSale(context: CommandContext, input: CreatePosSaleRequest, idempotencyKey: string) {
    const shift = await this.shiftScope(context, input.shiftId);
    this.authorize(context, 'pos.sale.create', shift);
    this.requireOwnShift(context, shift.cashierUserId);
    return this.command(context, 'pos.createSale', idempotencyKey, input, (client) =>
      createPosSale(this.requirePool(), client, { shiftId: shift.id, ...this.meta(context) }));
  }

  /** Cashier-side sale work: the sale's warehouse scope, and the caller's own shift. */
  private async cashierSale(context: CommandContext, saleId: string, permission: string): Promise<PosSaleScope> {
    const sale = await this.saleScope(context, saleId);
    this.authorize(context, permission, sale);
    this.requireOwnShift(context, sale.cashierUserId);
    return sale;
  }

  async saleDetail(context: CommandContext, saleId: string) {
    const sale = await this.saleScope(context, saleId);
    const ownSale = sale.cashierUserId === context.user.id && this.canAt(context, 'pos.sale.create', sale);
    if (!ownSale && !this.canAt(context, 'fulfillment.pickup.handover', sale)) throw new DomainError('NOT_FOUND');
    return PosSaleResponseSchema.parse(await getPosSale(this.requirePool(), sale.id));
  }

  async addLine(context: CommandContext, saleId: string, input: AddPosSaleLineRequest, idempotencyKey: string) {
    const sale = await this.cashierSale(context, saleId, 'pos.sale.create');
    return this.command(context, 'pos.addLine', idempotencyKey, { saleId: sale.id, ...input }, async (client) =>
      AddPosSaleLineResponseSchema.parse(await addPosSaleLine(this.requirePool(), client, {
        saleId: sale.id, priceListScope: DEFAULT_PRICE_LIST_SCOPE, barcode: input.barcode,
        ...(input.qty ? { qty: input.qty } : {}), ...this.meta(context),
      })));
  }

  async updateLine(context: CommandContext, saleId: string, lineId: string, input: UpdatePosSaleLineRequest, idempotencyKey: string) {
    const sale = await this.cashierSale(context, saleId, 'pos.sale.create');
    const line = uuidParam(lineId, 'lineId');
    return this.command(context, 'pos.updateLine', idempotencyKey, { saleId: sale.id, lineId: line, ...input }, async (client) =>
      PosCartTotalResponseSchema.parse(await updatePosSaleLine(this.requirePool(), client, { saleId: sale.id, lineId: line, qty: input.qty, ...this.meta(context) })));
  }

  async removeLine(context: CommandContext, saleId: string, lineId: string, idempotencyKey: string) {
    const sale = await this.cashierSale(context, saleId, 'pos.sale.create');
    const line = uuidParam(lineId, 'lineId');
    return this.command(context, 'pos.removeLine', idempotencyKey, { saleId: sale.id, lineId: line }, async (client) =>
      PosCartTotalResponseSchema.parse(await removePosSaleLine(this.requirePool(), client, { saleId: sale.id, lineId: line, ...this.meta(context) })));
  }

  async checkout(context: CommandContext, saleId: string, idempotencyKey: string) {
    const sale = await this.cashierSale(context, saleId, 'pos.sale.checkout');
    return this.command(context, 'pos.checkout', idempotencyKey, { saleId: sale.id }, async (client) => {
      const result = await checkoutPosSale(this.requirePool(), client, { saleId: sale.id, ...this.meta(context) });
      return CheckoutPosSaleResponseSchema.parse({
        id: result.id, status: result.status, salesOrderId: result.salesOrderId, invoiceNumber: result.invoiceNumber, total: result.total,
      });
    });
  }

  async acceptTender(context: CommandContext, saleId: string, input: AcceptPosTenderRequest, idempotencyKey: string) {
    const sale = await this.cashierSale(context, saleId, 'pos.tender.accept');
    return this.command(context, 'pos.acceptTender', idempotencyKey, { saleId: sale.id, ...input }, async (client) => {
      const result = await acceptPosTender(this.requirePool(), client, {
        saleId: sale.id, method: input.method, cashReceived: input.cashReceived, acceptedBy: context.user.id, ...this.meta(context),
      });
      return AcceptPosTenderResponseSchema.parse({
        tender: { id: result.tenderId, method: 'TUNAI', status: 'ACCEPTED', amount: result.amount, cashReceived: result.cashReceived, changeAmount: result.changeAmount },
        sale: { id: sale.id, status: result.saleStatus },
      });
    });
  }

  /** POS-011: copy 1 is part of taking payment; any later copy is a reprint and needs `pos.receipt.reprint`. */
  async printReceipt(context: CommandContext, saleId: string, input: PrintPosReceiptRequest, idempotencyKey: string) {
    const sale = await this.cashierSale(context, saleId, input.reprintReason ? 'pos.receipt.reprint' : 'pos.tender.accept');
    return this.command(context, 'pos.printReceipt', idempotencyKey, { saleId: sale.id, ...input }, async (client) =>
      PosReceiptResponseSchema.parse(await printPosReceipt(this.requirePool(), client, {
        saleId: sale.id, printedBy: context.user.id, reprintReason: input.reprintReason, ...this.meta(context),
      })));
  }

  async pickups(context: CommandContext) {
    this.requireHeldPermission(context, 'fulfillment.pickup.handover');
    const pickups = await listPickupsAwaitingHandover(this.requirePool(), context.user.organizationId);
    return PosPickupListResponseSchema.parse({
      items: pickups
        .filter((pickup) => this.canAt(context, 'fulfillment.pickup.handover', { organizationId: context.user.organizationId, ...pickup }))
        .map((pickup) => ({ saleId: pickup.saleId, invoiceNumber: pickup.invoiceNumber, total: pickup.total, paidAt: pickup.paidAt, lines: pickup.lines })),
    });
  }

  /** POS-010: warehouse staff, any shift. SOD-09 (not the cashier who took the money) is enforced in `fulfillment`. */
  async confirmPickupHandover(context: CommandContext, saleId: string, input: ConfirmPosPickupHandoverRequest, idempotencyKey: string) {
    const sale = await this.saleScope(context, saleId);
    this.authorize(context, 'fulfillment.pickup.handover', sale);
    return this.command(context, 'pos.confirmPickupHandover', idempotencyKey, { saleId: sale.id, ...input }, async (client) =>
      ConfirmPosPickupHandoverResponseSchema.parse(await confirmPosPickupHandover(this.requirePool(), client, {
        saleId: sale.id, actorId: context.user.id, receiverName: input.receiverName, ...this.meta(context),
      })));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * `/pos/*` (commands) and `/kasir/*` (reads for PSS Kasir) per §46A, behind the MVP-OD-5 demo
 * switch. Every route resolves the caller from the session; every mutating route validates its
 * body and requires an `Idempotency-Key` (scripts/check-command-fitness.mjs).
 */
@Controller()
@UseGuards(DemoPosFeatureGuard)
export class PosController {
  constructor(
    @Inject(PosService) private readonly pos: PosService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async currentUser(request: ApiRequest) {
    const user = await this.identity.getCurrentUser(request.headers.authorization);
    return this.pos.context(user, request);
  }

  @Get('kasir/terminals')
  async terminals(@Req() request: ApiRequest) {
    return this.pos.terminals(await this.currentUser(request));
  }

  @Post('pos/shifts')
  async openShift(@Req() request: ApiRequest, @Body(new ZodValidationPipe(OpenPosShiftRequestSchema)) body: OpenPosShiftRequest) {
    const key = readIdempotencyKey(request);
    return this.pos.openShift(await this.currentUser(request), body, key);
  }

  @Post('pos/shifts/:id/close')
  async closeShift(@Req() request: ApiRequest, @Param('id') shiftId: string, @Body(new ZodValidationPipe(ClosePosShiftRequestSchema)) body: ClosePosShiftRequest) {
    const key = readIdempotencyKey(request);
    return this.pos.closeShift(await this.currentUser(request), shiftId, body, key);
  }

  @Post('pos/shifts/:id/cash-handover')
  async declareCashHandover(@Req() request: ApiRequest, @Param('id') shiftId: string) {
    const key = readIdempotencyKey(request);
    return this.pos.declareCashHandover(await this.currentUser(request), shiftId, key);
  }

  @Get('kasir/shift-saya')
  async shiftSaya(@Req() request: ApiRequest) {
    return this.pos.shiftSaya(await this.currentUser(request));
  }

  @Get('kasir/products')
  async katalog(@Req() request: ApiRequest, @Query('q') query: string) {
    return this.pos.katalog(await this.currentUser(request), query ?? '');
  }

  @Get('kasir/scan/:barcode')
  async scan(@Req() request: ApiRequest, @Param('barcode') barcode: string) {
    return this.pos.scan(await this.currentUser(request), barcode);
  }

  @Post('pos/sales')
  async createSale(@Req() request: ApiRequest, @Body(new ZodValidationPipe(CreatePosSaleRequestSchema)) body: CreatePosSaleRequest) {
    const key = readIdempotencyKey(request);
    return this.pos.createSale(await this.currentUser(request), body, key);
  }

  @Get('pos/sales/:id')
  async saleDetail(@Req() request: ApiRequest, @Param('id') saleId: string) {
    return this.pos.saleDetail(await this.currentUser(request), saleId);
  }

  @Post('pos/sales/:id/lines')
  async addLine(@Req() request: ApiRequest, @Param('id') saleId: string, @Body(new ZodValidationPipe(AddPosSaleLineRequestSchema)) body: AddPosSaleLineRequest) {
    const key = readIdempotencyKey(request);
    return this.pos.addLine(await this.currentUser(request), saleId, body, key);
  }

  @Patch('pos/sales/:id/lines/:lineId')
  async updateLine(
    @Req() request: ApiRequest, @Param('id') saleId: string, @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(UpdatePosSaleLineRequestSchema)) body: UpdatePosSaleLineRequest,
  ) {
    const key = readIdempotencyKey(request);
    return this.pos.updateLine(await this.currentUser(request), saleId, lineId, body, key);
  }

  @Delete('pos/sales/:id/lines/:lineId')
  async removeLine(@Req() request: ApiRequest, @Param('id') saleId: string, @Param('lineId') lineId: string) {
    const key = readIdempotencyKey(request);
    return this.pos.removeLine(await this.currentUser(request), saleId, lineId, key);
  }

  @Post('pos/sales/:id/checkout')
  async checkout(@Req() request: ApiRequest, @Param('id') saleId: string) {
    const key = readIdempotencyKey(request);
    return this.pos.checkout(await this.currentUser(request), saleId, key);
  }

  @Post('pos/sales/:id/tenders')
  async acceptTender(@Req() request: ApiRequest, @Param('id') saleId: string, @Body(new ZodValidationPipe(AcceptPosTenderRequestSchema)) body: AcceptPosTenderRequest) {
    const key = readIdempotencyKey(request);
    return this.pos.acceptTender(await this.currentUser(request), saleId, body, key);
  }

  @Post('pos/sales/:id/receipt-prints')
  async printReceipt(@Req() request: ApiRequest, @Param('id') saleId: string, @Body(new ZodValidationPipe(PrintPosReceiptRequestSchema)) body: PrintPosReceiptRequest) {
    const key = readIdempotencyKey(request);
    return this.pos.printReceipt(await this.currentUser(request), saleId, body, key);
  }

  @Get('pos/pickups')
  async pickups(@Req() request: ApiRequest) {
    return this.pos.pickups(await this.currentUser(request));
  }

  @Post('pos/sales/:id/pickup-handover')
  async confirmPickupHandover(
    @Req() request: ApiRequest, @Param('id') saleId: string,
    @Body(new ZodValidationPipe(ConfirmPosPickupHandoverRequestSchema)) body: ConfirmPosPickupHandoverRequest,
  ) {
    const key = readIdempotencyKey(request);
    return this.pos.confirmPickupHandover(await this.currentUser(request), saleId, body, key);
  }
}
