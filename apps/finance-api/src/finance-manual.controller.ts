import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { DomainError, FinanceManualJournalSchema, FinanceReasonSchema } from '@pss/contracts';
import { createManualJournal, requestJournalReversal, submitManualJournal } from '@pss/finance';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { IdempotencyError, runCommand } from '@pss/platform';
import { Pool } from 'pg';
import { z } from 'zod';
import { FinanceAuth } from './finance-auth';

type Request = Parameters<typeof readIdempotencyKey>[0];

@Controller('finance/journals')
export class FinanceManualController {
  constructor(@Inject(FinanceAuth) private readonly auth: FinanceAuth,
    @Inject('FINANCE_POOL') private readonly pool: Pool) {}

  @Post()
  async create(@Req() request: Request,
    @Body(new ZodValidationPipe(FinanceManualJournalSchema)) body: z.infer<typeof FinanceManualJournalSchema>) {
    const user = await this.auth.require(request.headers.authorization, 'finance.journal.create');
    const idempotencyKey = readIdempotencyKey(request);
    try {
      const response = await runCommand(this.pool, {
        organizationId: user.organizationId, identityId: user.id,
        commandName: 'finance.journal.create', key: idempotencyKey,
        requestHash: hashRequestBody(body),
      }, async (transaction) => ({
        code: 201,
        body: await createManualJournal(transaction, {
          ...body, organizationId: user.organizationId, makerId: user.id,
          requestId: request.headers['x-request-id']?.toString() ?? idempotencyKey,
        }),
      }));
      return response.body;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  @Post(':id/submit')
  async submit(@Req() request: Request, @Param('id') id: string) {
    const user = await this.auth.require(request.headers.authorization, 'finance.journal.submit');
    if (!z.uuid().safeParse(id).success) throw new DomainError('VALIDATION_FAILED');
    const idempotencyKey = readIdempotencyKey(request);
    try {
      const result = await runCommand(this.pool, {
        organizationId: user.organizationId, identityId: user.id,
        commandName: 'finance.journal.submit', key: idempotencyKey, requestHash: hashRequestBody({ id }),
      }, async (transaction) => ({ code: 200, body: await submitManualJournal(transaction, {
        organizationId: user.organizationId, journalId: id, makerId: user.id,
        requestId: request.headers['x-request-id']?.toString() ?? idempotencyKey,
      }) }));
      return result.body;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  @Post(':id/reversal-requests')
  async requestReversal(@Req() request: Request, @Param('id') id: string,
    @Body(new ZodValidationPipe(FinanceReasonSchema)) body: z.infer<typeof FinanceReasonSchema>) {
    const user = await this.auth.require(request.headers.authorization, 'finance.journal.reverse.request');
    if (!z.uuid().safeParse(id).success) throw new DomainError('VALIDATION_FAILED');
    const idempotencyKey = readIdempotencyKey(request);
    try {
      const result = await runCommand(this.pool, {
        organizationId: user.organizationId, identityId: user.id,
        commandName: 'finance.journal.reversal.request', key: idempotencyKey,
        requestHash: hashRequestBody({ id, ...body }),
      }, async (transaction) => ({ code: 202, body: await requestJournalReversal(transaction, {
        organizationId: user.organizationId, journalId: id, makerId: user.id,
        reason: body.reason, requestId: request.headers['x-request-id']?.toString() ?? idempotencyKey,
      }) }));
      return result.body;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }
}
