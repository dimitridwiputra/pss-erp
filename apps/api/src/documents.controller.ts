import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Query, Req } from '@nestjs/common';
import { DomainError, type CurrentUserResponse } from '@pss/contracts';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import {
  confirmDocumentNumber, createNumberingScheme, IdempotencyError, listNumberingSchemes,
  numberSequenceUsage, reserveDocumentNumber, runCommand, seedDraftNumberingSchemes, voidDocumentNumber,
} from '@pss/platform';
import type { AuditedTransaction } from '@pss/platform';
import { Pool } from 'pg';
import { z } from 'zod';
import { IdentityService } from './identity.controller';

type AuthedRequest = { headers: { authorization?: string; 'x-request-id'?: string; 'idempotency-key'?: string } };

const DocTypeSchema = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/);

const CreateSchemeBodySchema = z.strictObject({
  docType: DocTypeSchema,
  branchId: z.uuid().optional(),
  /**
   * GAP-16 is open, so the pattern, branch code, gap policy, and padding are all optional and
   * default to unset. A DRAFT scheme records what an operator believes the format should be
   * without it becoming effective; an ACTIVE one requires every field, which the domain refuses
   * to create otherwise.
   */
  status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
  pattern: z.string().trim().min(1).max(120).optional(),
  branchCode: z.string().trim().min(1).max(20).optional(),
  resetPolicy: z.enum(['YEARLY', 'MONTHLY', 'NEVER']).optional(),
  gapPolicy: z.enum(['NO_GAP_FISCAL', 'GAP_ALLOWED']).optional(),
  padding: z.int().min(1).max(20).optional(),
  startAt: z.int().min(1).default(1),
  validFrom: z.iso.date(),
});
type CreateSchemeBody = z.infer<typeof CreateSchemeBodySchema>;

const ReserveBodySchema = z.strictObject({
  docType: DocTypeSchema,
  branchId: z.uuid().optional(),
  /** The document's own Asia/Jakarta business date; it selects the sequence period (DOC-001.BR05). */
  documentDate: z.iso.date(),
  /** DOC-001.R02: a retry with the same key returns the same number instead of a new one. */
  requestKey: z.string().trim().min(1).max(200),
});
type ReserveBody = z.infer<typeof ReserveBodySchema>;

const ConfirmBodySchema = z.strictObject({
  documentId: z.string().trim().min(1).max(200),
});
type ConfirmBody = z.infer<typeof ConfirmBodySchema>;

const VoidBodySchema = z.strictObject({
  /** DOC-001.R05: a cancelled number always states why, and the actor is recorded with it. */
  reason: z.string().trim().min(1).max(500),
});
type VoidBody = z.infer<typeof VoidBodySchema>;

/**
 * DOC-001 — the numbering surface. Configuration is a System Console concern (SYSTEM_ADMIN);
 * reserving, confirming, and voiding a number is a domain command, not something a browser
 * should be able to do directly, so those routes are provided for a trusted server-side caller
 * and are audited with the calling user as the actor.
 *
 * PLT-006: every mutating route carries a client `Idempotency-Key`. A number is the resource
 * most damaging to re-issue (DEC-106), so the replay is the guarantee that a network retry can
 * never mint a second one.
 */
@Injectable()
export class DocumentNumberingService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  private requireUser(authorizationHeader: string | undefined): Promise<CurrentUserResponse> {
    if (!authorizationHeader) throw new DomainError('UNAUTHENTICATED');
    return this.identity.getCurrentUser(authorizationHeader);
  }

  /**
   * The audited transaction is threaded into the command rather than a bare pool, so the
   * idempotency row, the mutation, and its audit entry share one commit (AGENTS.md §3.6).
   * Passing only `pool` here committed the mutation on a second connection while the
   * idempotency row was still in flight, so a failed outer commit left a mutation that a
   * retry would re-apply.
   */
  private async withIdempotency<T>(
    user: CurrentUserResponse, commandName: string, idempotencyKey: string,
    requestBody: unknown, execute: (transaction: AuditedTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await runCommand(
        this.requirePool(),
        {
          organizationId: user.organizationId, identityId: user.id, commandName,
          key: idempotencyKey, requestHash: hashRequestBody(requestBody),
        },
        async (transaction) => ({ code: 200, body: await execute(transaction) }),
      );
      return result.body as T;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  async createScheme(
    authorizationHeader: string | undefined, body: CreateSchemeBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireUser(authorizationHeader);
    return this.withIdempotency(user, 'platform.createNumberingScheme', idempotencyKey, body, (transaction) =>
      createNumberingScheme(this.requirePool(), {
        ...body, organizationId: user.organizationId, requestId,
      }, transaction));
  }

  /** DOC-001.R04: the S3 document types registered as DRAFT so Finance/Ops can review GAP-16. */
  async seedDrafts(
    authorizationHeader: string | undefined, body: { branchId?: string }, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireUser(authorizationHeader);
    return this.withIdempotency(user, 'platform.seedDraftNumberingSchemes', idempotencyKey, body, (transaction) =>
      seedDraftNumberingSchemes(this.requirePool(), {
        organizationId: user.organizationId, ...(body.branchId ? { branchId: body.branchId } : {}), requestId,
      }, transaction));
  }

  async reserve(
    authorizationHeader: string | undefined, body: ReserveBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireUser(authorizationHeader);
    return this.withIdempotency(user, 'platform.reserveDocumentNumber', idempotencyKey, body, (transaction) =>
      reserveDocumentNumber(this.requirePool(), {
        ...body, organizationId: user.organizationId, reservedBy: user.id,
        requestingDomain: 'api', requestId,
      }, transaction));
  }

  async confirm(
    authorizationHeader: string | undefined, reservationId: string, body: ConfirmBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireUser(authorizationHeader);
    return this.withIdempotency(user, 'platform.confirmDocumentNumber', idempotencyKey, { reservationId, ...body }, (transaction) =>
      confirmDocumentNumber(this.requirePool(), {
        organizationId: user.organizationId, reservationId, documentId: body.documentId, requestId,
      }, transaction));
  }

  async voidNumber(
    authorizationHeader: string | undefined, reservationId: string, body: VoidBody, idempotencyKey: string, requestId: string,
  ) {
    const user = await this.requireUser(authorizationHeader);
    return this.withIdempotency(user, 'platform.voidDocumentNumber', idempotencyKey, { reservationId, ...body }, (transaction) =>
      voidDocumentNumber(this.requirePool(), {
        organizationId: user.organizationId, reservationId, reason: body.reason,
        voidedBy: user.id, requestId,
      }, transaction));
  }

  async listSchemes(authorizationHeader: string | undefined, branchId?: string) {
    const user = await this.requireUser(authorizationHeader);
    return { schemes: await listNumberingSchemes(this.requirePool(), user.organizationId, branchId) };
  }

  /** DOC-001.R03 / AC06: the sequence report, so every gap is explained by a recorded BATAL. */
  async usage(authorizationHeader: string | undefined, docType: string, branchId?: string) {
    const user = await this.requireUser(authorizationHeader);
    return { usage: await numberSequenceUsage(this.requirePool(), user.organizationId, docType, branchId) };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Controller('platform/documents')
export class DocumentsController {
  constructor(@Inject(DocumentNumberingService) private readonly documents: DocumentNumberingService) {}

  private idempotencyKey(request: AuthedRequest): string {
    return readIdempotencyKey(request as never);
  }

  private requestId(request: AuthedRequest): string {
    return request.headers['x-request-id'] ?? randomUUID();
  }

  @Get('numbering/schemes')
  listSchemes(
    @Req() request: AuthedRequest,
    @Query('branchId', new ZodValidationPipe(z.uuid().optional())) branchId?: string,
  ) {
    return this.documents.listSchemes(request.headers.authorization, branchId);
  }

  @Post('numbering/schemes')
  createScheme(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(CreateSchemeBodySchema)) body: CreateSchemeBody,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.documents.createScheme(request.headers.authorization, body, idempotencyKey, this.requestId(request));
  }

  @Post('numbering/schemes/seed-drafts')
  seedDrafts(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(z.strictObject({ branchId: z.uuid().optional() }))) body: { branchId?: string },
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.documents.seedDrafts(request.headers.authorization, body, idempotencyKey, this.requestId(request));
  }

  @Get('numbering/usage')
  usage(
    @Req() request: AuthedRequest,
    @Query('docType', new ZodValidationPipe(DocTypeSchema)) docType: string,
    @Query('branchId', new ZodValidationPipe(z.uuid().optional())) branchId?: string,
  ) {
    return this.documents.usage(request.headers.authorization, docType, branchId);
  }

  @Post('numbers/reserve')
  reserve(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(ReserveBodySchema)) body: ReserveBody,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.documents.reserve(request.headers.authorization, body, idempotencyKey, this.requestId(request));
  }

  @Post('numbers/:id/confirm')
  confirm(
    @Req() request: AuthedRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) reservationId: string,
    @Body(new ZodValidationPipe(ConfirmBodySchema)) body: ConfirmBody,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.documents.confirm(
      request.headers.authorization, reservationId, body, idempotencyKey, this.requestId(request),
    );
  }

  @Post('numbers/:id/void')
  voidNumber(
    @Req() request: AuthedRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) reservationId: string,
    @Body(new ZodValidationPipe(VoidBodySchema)) body: VoidBody,
  ) {
    const idempotencyKey = this.idempotencyKey(request);
    return this.documents.voidNumber(
      request.headers.authorization, reservationId, body, idempotencyKey, this.requestId(request),
    );
  }
}
