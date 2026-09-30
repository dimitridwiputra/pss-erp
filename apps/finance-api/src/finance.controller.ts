import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import {
  DomainError, FinanceDateRangeQuerySchema, FinanceLedgerQuerySchema,
  FinancePageQuerySchema, FinanceThroughQuerySchema,
} from '@pss/contracts';
import {
  balanceSheet, financeSummary, generalLedger, getJournal, listAccounts, listJournals,
  listPeriods, listPostingExceptions, profitAndLoss, reconciliation, trialBalance,
} from '@pss/finance';
import { Pool } from 'pg';
import { z } from 'zod';
import { FinanceAuth } from './finance-auth';

type Request = { headers: { authorization?: string } };
const readPermissions = ['finance.journal.create', 'finance.journal.approve', 'finance.close.manage'] as const;
const date = z.iso.date();

@Controller('finance')
export class FinanceController {
  constructor(@Inject(FinanceAuth) private readonly auth: FinanceAuth,
    @Inject('FINANCE_POOL') private readonly pool: Pool) {}

  @Get('accounts')
  async accounts(@Req() request: Request) {
    await this.auth.require(request.headers.authorization, readPermissions);
    return listAccounts(this.pool);
  }

  @Get('journals')
  async journals(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return listJournals(this.pool, user.organizationId, FinancePageQuerySchema.parse(query));
  }

  @Get('journals/:id')
  async journal(@Req() request: Request, @Param('id') id: string) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    if (!z.uuid().safeParse(id).success) throw new DomainError('VALIDATION_FAILED');
    const result = await getJournal(this.pool, user.organizationId, id);
    if (!result) throw new DomainError('NOT_FOUND');
    return result;
  }

  @Get('ledger')
  async ledger(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    const input = FinanceLedgerQuerySchema.parse(query);
    return generalLedger(this.pool, user.organizationId, input.accountCode, input.from, input.to, input);
  }

  @Get('trial-balance')
  async trialBalance(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return trialBalance(this.pool, user.organizationId, FinanceThroughQuerySchema.parse(query).through);
  }

  @Get('profit-and-loss')
  async profitAndLoss(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    const input = FinanceDateRangeQuerySchema.parse(query);
    return profitAndLoss(this.pool, user.organizationId, input.from, input.to);
  }

  @Get('balance-sheet')
  async balanceSheet(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return balanceSheet(this.pool, user.organizationId, FinanceThroughQuerySchema.parse(query).through);
  }

  @Get('reconciliation')
  async reconciliation(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return reconciliation(this.pool, user.organizationId, FinanceThroughQuerySchema.parse(query).through);
  }

  @Get('summary')
  async summary(@Req() request: Request, @Query('businessDate') rawDate: string | undefined) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return financeSummary(this.pool, user.organizationId, date.parse(rawDate));
  }

  @Get('posting-exceptions')
  async exceptions(@Req() request: Request, @Query() query: unknown) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return listPostingExceptions(this.pool, user.organizationId, FinancePageQuerySchema.parse(query));
  }

  @Get('periods')
  async periods(@Req() request: Request) {
    const user = await this.auth.require(request.headers.authorization, readPermissions);
    return listPeriods(this.pool, user.organizationId);
  }
}
