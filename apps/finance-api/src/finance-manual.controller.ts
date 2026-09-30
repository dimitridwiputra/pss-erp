import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { DomainError, FinanceManualJournalSchema } from '@pss/contracts';
import { createManualJournal } from '@pss/finance';
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
}
