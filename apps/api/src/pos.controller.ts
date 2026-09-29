import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Req } from '@nestjs/common';
import {
  AcceptPosTenderRequestSchema, CheckoutPosSaleResponseSchema, DomainError,
  KasirScanResponseSchema, KasirShiftSayaResponseSchema, OpenPosShiftRequestSchema,
  PosShiftResponseSchema, PosTerminalResponseSchema, RegisterPosTerminalRequestSchema,
  SyncPosOfflineBatchRequestSchema, type AcceptPosTenderResponse, type CheckoutPosSaleResponse,
  type CurrentUserResponse, type KasirScanResponse, type KasirShiftSayaResponse,
  type PosShiftResponse, type PosTerminalResponse, type SyncPosOfflineBatchResponse,
} from '@pss/contracts';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import {
  acceptPosTender, addPosSaleLine, checkoutPosSale, closePosShift, confirmPosPickupHandover,
  createPosSale, declarePosCashHandover, getShiftSaya, openPosShift, registerPosTerminal,
  syncPosOfflineBatch,
} from '@pss/pos';
import { findProductByBarcode } from '@pss/master-data';
import { resolvePrice } from '@pss/commercial';
import { Pool } from 'pg';
import { IdentityService } from './identity.controller';

type AuthedRequest = { headers: { authorization?: string; 'idempotency-key'?: string } };

/** Price list scope is a config value (PLT-009) not yet wired; a single default is used until then. */
const DEFAULT_PRICE_LIST_SCOPE = 'KONTER';

@Injectable()
export class PosService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  async registerTerminal(user: CurrentUserResponse, input: { warehouseId: string; code: string; name: string; deviceId?: string }): Promise<PosTerminalResponse> {
    if (!user.primaryBranchId) throw new DomainError('VALIDATION_FAILED');
    const terminal = await registerPosTerminal(this.requirePool(), {
      organizationId: user.organizationId, branchId: user.primaryBranchId, warehouseId: input.warehouseId,
      code: input.code, name: input.name, deviceId: input.deviceId,
      actor: { userId: user.id, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    return PosTerminalResponseSchema.parse(terminal);
  }

  async openShift(user: CurrentUserResponse, input: { terminalId: string; openingFloat: string }): Promise<PosShiftResponse> {
    const shift = await openPosShift(this.requirePool(), {
      organizationId: user.organizationId, terminalId: input.terminalId, cashierUserId: user.id, openingFloat: input.openingFloat,
      actor: { userId: user.id, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    return PosShiftResponseSchema.parse({ ...shift, openingFloat: input.openingFloat, expectedCash: null, countedCash: null, variance: null });
  }

  async closeShift(user: CurrentUserResponse, shiftId: string, input: { countedCash: string; denominations?: Record<string, number>; reasonCode?: string; note?: string }) {
    return closePosShift(this.requirePool(), {
      shiftId, countedCash: input.countedCash, denominations: input.denominations, reasonCode: input.reasonCode, note: input.note,
      actor: { userId: user.id, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
  }

  async declareCashHandover(shiftId: string) {
    return declarePosCashHandover(this.requirePool(), { shiftId });
  }

  async shiftSaya(user: CurrentUserResponse): Promise<KasirShiftSayaResponse> {
    const result = await getShiftSaya(this.requirePool(), user.id);
    return KasirShiftSayaResponseSchema.parse(result);
  }

  async scan(user: CurrentUserResponse, barcode: string): Promise<KasirScanResponse> {
    const match = await findProductByBarcode(this.requirePool(), { organizationId: user.organizationId, barcode });
    if (!match) throw new DomainError('NOT_FOUND');
    const price = await resolvePrice(this.requirePool(), {
      organizationId: user.organizationId, productId: match.productId, uom: match.uom, priceListScope: DEFAULT_PRICE_LIST_SCOPE,
    });
    return KasirScanResponseSchema.parse({
      productId: match.productId, sku: match.sku, name: match.name, uom: match.uom,
      unitPrice: price.unitPrice, qtyAvailable: null,
    });
  }

  async createSale(user: CurrentUserResponse, input: { terminalId: string; shiftId: string }) {
    return createPosSale(this.requirePool(), { organizationId: user.organizationId, terminalId: input.terminalId, shiftId: input.shiftId });
  }

  async addLine(user: CurrentUserResponse, saleId: string, input: Record<string, unknown>) {
    return addPosSaleLine(this.requirePool(), {
      organizationId: user.organizationId, saleId, priceListScope: DEFAULT_PRICE_LIST_SCOPE, ...input,
    } as Parameters<typeof addPosSaleLine>[1]);
  }

  async checkout(user: CurrentUserResponse, saleId: string): Promise<CheckoutPosSaleResponse> {
    const result = await checkoutPosSale(this.requirePool(), {
      saleId, actor: { userId: user.id, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    return CheckoutPosSaleResponseSchema.parse({
      id: result.id, status: result.status, salesOrderId: result.salesOrderId, invoiceNumber: result.invoiceNumber, total: result.total,
    });
  }

  async acceptTender(user: CurrentUserResponse, saleId: string, input: { method: 'TUNAI'; cashReceived: string }): Promise<AcceptPosTenderResponse> {
    const result = await acceptPosTender(this.requirePool(), {
      saleId, method: input.method, cashReceived: input.cashReceived, acceptedBy: user.id,
      requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    return {
      tender: { id: result.tenderId, method: 'TUNAI', status: 'ACCEPTED', amount: result.amount, changeAmount: result.changeAmount },
      sale: { id: saleId, status: result.saleStatus },
    };
  }

  async confirmHandover(user: CurrentUserResponse, saleId: string, receiverName: string) {
    return confirmPosPickupHandover(this.requirePool(), {
      saleId, actorId: user.id, receiverName, sodCashierNotHandoverEnabled: true,
      businessDate: new Date().toISOString().slice(0, 10),
      actor: { userId: user.id, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
  }

  async sync(user: CurrentUserResponse, input: { terminalId: string; sales: unknown[] }): Promise<SyncPosOfflineBatchResponse> {
    return syncPosOfflineBatch(this.requirePool(), {
      organizationId: user.organizationId, terminalId: input.terminalId, priceListScope: DEFAULT_PRICE_LIST_SCOPE, actorId: user.id,
      sales: input.sales,
    } as Parameters<typeof syncPosOfflineBatch>[1]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * `/pos/*` (commands) and `/kasir/*` (BFF reads for PSS Kasir) per §46A. Every write
 * resolves the acting user from the session (never trusts a client-supplied
 * organizationId/userId), matching `IdentityController`'s auth pattern — this
 * controller has no independent auth of its own.
 */
@Controller()
export class PosController {
  constructor(
    @Inject(PosService) private readonly pos: PosService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private currentUser(request: AuthedRequest): Promise<CurrentUserResponse> {
    return this.identity.getCurrentUser(request.headers.authorization);
  }

  @Post('pos/terminals')
  async registerTerminal(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(RegisterPosTerminalRequestSchema)) body: unknown) {
    readIdempotencyKey(request as never);
    hashRequestBody(body);
    const user = await this.currentUser(request);
    return this.pos.registerTerminal(user, body as { warehouseId: string; code: string; name: string; deviceId?: string });
  }

  @Post('pos/shifts')
  async openShift(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(OpenPosShiftRequestSchema)) body: { terminalId: string; openingFloat: string }) {
    const user = await this.currentUser(request);
    return this.pos.openShift(user, body);
  }

  @Post('pos/shifts/:id/close')
  async closeShift(@Req() request: AuthedRequest, @Param('id') shiftId: string, @Body() body: { countedCash: string; denominations?: Record<string, number>; reasonCode?: string; note?: string }) {
    const user = await this.currentUser(request);
    return this.pos.closeShift(user, shiftId, body);
  }

  @Post('pos/shifts/:id/cash-handover')
  async declareCashHandover(@Param('id') shiftId: string) {
    return this.pos.declareCashHandover(shiftId);
  }

  @Get('kasir/shift-saya')
  async shiftSaya(@Req() request: AuthedRequest) {
    const user = await this.currentUser(request);
    return this.pos.shiftSaya(user);
  }

  @Get('kasir/scan/:barcode')
  async scan(@Req() request: AuthedRequest, @Param('barcode') barcode: string) {
    const user = await this.currentUser(request);
    return this.pos.scan(user, barcode);
  }

  @Post('pos/sales')
  async createSale(@Req() request: AuthedRequest, @Body() body: { terminalId: string; shiftId: string }) {
    const user = await this.currentUser(request);
    return this.pos.createSale(user, body);
  }

  @Post('pos/sales/:id/lines')
  async addLine(@Req() request: AuthedRequest, @Param('id') saleId: string, @Body() body: Record<string, unknown>) {
    const user = await this.currentUser(request);
    return this.pos.addLine(user, saleId, body);
  }

  @Post('pos/sales/:id/checkout')
  async checkout(@Req() request: AuthedRequest, @Param('id') saleId: string) {
    const user = await this.currentUser(request);
    return this.pos.checkout(user, saleId);
  }

  @Post('pos/sales/:id/tenders')
  async acceptTender(@Req() request: AuthedRequest, @Param('id') saleId: string, @Body(new ZodValidationPipe(AcceptPosTenderRequestSchema)) body: { method: 'TUNAI'; cashReceived: string }) {
    const user = await this.currentUser(request);
    return this.pos.acceptTender(user, saleId, body);
  }

  @Post('pos/sales/:id/pickup-handover')
  async confirmHandover(@Req() request: AuthedRequest, @Param('id') saleId: string, @Body() body: { receiverName: string }) {
    const user = await this.currentUser(request);
    return this.pos.confirmHandover(user, saleId, body.receiverName);
  }

  @Post('kasir/sync')
  async sync(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(SyncPosOfflineBatchRequestSchema)) body: { terminalId: string; sales: unknown[] }) {
    const user = await this.currentUser(request);
    return this.pos.sync(user, body);
  }
}
