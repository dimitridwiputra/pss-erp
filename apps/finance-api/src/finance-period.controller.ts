import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { DomainError, FinanceCloseSchema, FinanceReasonSchema, type CurrentUserResponse } from '@pss/contracts';
import { requestPeriodClose, requestPeriodReopen, softClosePeriod } from '@pss/finance';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { IdempotencyError, runCommand, type AuditedTransaction, type CommandResponse } from '@pss/platform';
import { Pool } from 'pg';
import { z } from 'zod';
import { FinanceAuth } from './finance-auth';

type Request = Parameters<typeof readIdempotencyKey>[0];

@Controller('finance/periods')
export class FinancePeriodController {
  constructor(@Inject(FinanceAuth) private readonly auth: FinanceAuth,
    @Inject('FINANCE_POOL') private readonly pool: Pool) {}

  private async command(request: Request, periodId: string, body: object,
    name: string, execute: (transaction: AuditedTransaction, user: CurrentUserResponse) => Promise<CommandResponse>,
    permission = 'finance.close.manage') {
    const user = await this.auth.require(request.headers.authorization, permission);
    if (!z.uuid().safeParse(periodId).success) throw new DomainError('VALIDATION_FAILED');
    try {
      const result = await runCommand(this.pool, {
        organizationId: user.organizationId, identityId: user.id,
        commandName: name, key: readIdempotencyKey(request), requestHash: hashRequestBody({ periodId, body }),
      }, (transaction) => execute(transaction, user));
      return result.body;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  @Post(':id/soft-close')
  softClose(@Req() request: Request, @Param('id') periodId: string,
    @Body(new ZodValidationPipe(FinanceReasonSchema)) body: z.infer<typeof FinanceReasonSchema>) {
    return this.command(request, periodId, body, 'finance.period.softClose', async (transaction, user) => ({
      code: 200, body: await softClosePeriod(transaction, {
        organizationId: user.organizationId, actorId: user.id,
        periodId, reason: body.reason, requestId: readIdempotencyKey(request),
      }),
    }));
  }

  @Post(':id/close')
  close(@Req() request: Request, @Param('id') periodId: string,
    @Body(new ZodValidationPipe(FinanceCloseSchema)) body: z.infer<typeof FinanceCloseSchema>) {
    return this.command(request, periodId, body, 'finance.period.close', async (transaction, user) => {
      return { code: 202, body: await requestPeriodClose(transaction, {
        organizationId: user.organizationId, actorId: user.id, periodId,
        reason: body.reason, overrideExceptions: body.overrideExceptions,
        requestId: readIdempotencyKey(request),
      }) };
    });
  }

  @Post(':id/reopen-requests')
  reopen(@Req() request: Request, @Param('id') periodId: string,
    @Body(new ZodValidationPipe(FinanceReasonSchema)) body: z.infer<typeof FinanceReasonSchema>) {
    return this.command(request, periodId, body, 'finance.period.reopen.request', async (transaction, user) => ({
      code: 202, body: await requestPeriodReopen(transaction, {
        organizationId: user.organizationId, actorId: user.id, periodId,
        reason: body.reason, requestId: readIdempotencyKey(request),
      }),
    }), 'finance.period.reopen.request');
  }
}
