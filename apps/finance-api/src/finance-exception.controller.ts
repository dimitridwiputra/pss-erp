import { Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { DomainError } from '@pss/contracts';
import { retryPostingException } from '@pss/finance';
import { hashRequestBody, readIdempotencyKey } from '@pss/http';
import { IdempotencyError, runCommand } from '@pss/platform';
import { Pool } from 'pg';
import { z } from 'zod';
import { FinanceAuth } from './finance-auth';

type Request = Parameters<typeof readIdempotencyKey>[0];

@Controller('finance/posting-exceptions')
export class FinanceExceptionController {
  constructor(@Inject(FinanceAuth) private readonly auth: FinanceAuth,
    @Inject('FINANCE_POOL') private readonly pool: Pool) {}

  @Post(':id/retry')
  async retry(@Req() request: Request, @Param('id') exceptionId: string) {
    const user = await this.auth.require(request.headers.authorization,
      ['finance.posting.period_decision', 'finance.close.manage']);
    if (!z.uuid().safeParse(exceptionId).success) throw new DomainError('VALIDATION_FAILED');
    try {
      const response = await runCommand(this.pool, {
        organizationId: user.organizationId, identityId: user.id,
        commandName: 'finance.postingException.retry', key: readIdempotencyKey(request),
        requestHash: hashRequestBody({ exceptionId }),
      }, async ({ client }) => ({ code: 200,
        body: await retryPostingException(client, user.organizationId, exceptionId) }));
      return response.body;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }
}
