import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Req } from '@nestjs/common';
import { DomainError } from '@pss/contracts';
import { ZodValidationPipe } from '@pss/http';
import { decideApproval, listPendingApprovals } from '@pss/platform';
import { Pool } from 'pg';
import { createApiPool } from './database-pool';
import { z } from 'zod';
import { IdentityService } from './identity.controller';

const DecisionSchema = z.strictObject({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().min(1).max(500),
});
type Request = { headers: { authorization?: string; 'x-request-id'?: string } };

function jakartaBusinessDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

@Injectable()
export class ApprovalService implements OnModuleDestroy {
  private readonly pool = createApiPool();
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  async inbox(authorizationHeader: string | undefined) {
    const user = await this.identity.getCurrentUser(authorizationHeader);
    return listPendingApprovals(this.requirePool(), user.organizationId, user.id,
      (access) => this.identity.canApprove(authorizationHeader, access, false));
  }

  async decide(authorizationHeader: string | undefined, approvalId: string,
    decision: 'APPROVED' | 'REJECTED', reason: string, requestId: string) {
    const user = await this.identity.getCurrentUser(authorizationHeader);
    return decideApproval(this.requirePool(), {
      approvalId, organizationId: user.organizationId, actorId: user.id,
      decision, reason, businessDate: jakartaBusinessDate(), requestId,
    }, (access) => this.identity.canApprove(authorizationHeader, access, true));
  }

  async onModuleDestroy(): Promise<void> { await this.pool?.end(); }
}

@Controller('platform/approvals')
export class ApprovalController {
  constructor(@Inject(ApprovalService) private readonly approval: ApprovalService) {}

  @Get('inbox')
  inbox(@Req() request: Request) { return this.approval.inbox(request.headers.authorization); }

  @Post(':id/decision')
  decide(@Req() request: Request, @Param('id') id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) body: z.infer<typeof DecisionSchema>) {
    if (!z.uuid().safeParse(id).success) throw new DomainError('VALIDATION_FAILED');
    return this.approval.decide(request.headers.authorization, id, body.decision, body.reason,
      request.headers['x-request-id'] ?? randomUUID());
  }
}
