import { Body, Controller, Get, Inject, Injectable, OnModuleDestroy, Param, Post, Query, Req } from '@nestjs/common';
import {
  AddWarehouseUnitLineRequestSchema, AllocatePickTaskRequestSchema, AssignExceptionRequestSchema,
  CompletePackingRequestSchema, ConfirmPickTaskRequestSchema, ConfirmPutawayRequestSchema,
  CreateWarehouseUnitRequestSchema, DomainError, HeartbeatRequestSchema, LoadPackageRequestSchema,
  NextWarehouseTaskResponseSchema, PrintLabelRequestSchema, ReceiveGoodsRequestSchema,
  ReconciliationResultResponseSchema, RegisterWarehouseLocationRequestSchema,
  ReportStockDiscrepancyRequestSchema, ResolveStockDiscrepancyRequestSchema, RunReconciliationRequestSchema,
  SetWarehouseLocationStatusRequestSchema, StagePackageRequestSchema, SubmitCycleCountRequestSchema,
  SyncOfflineConfirmationsRequestSchema, WarehouseDashboardResponseSchema, WarehouseTaskTypeSchema,
  WarehouseTaskStatusSchema,
  type AddWarehouseUnitLineRequest, type AllocatePickTaskRequest, type AssignExceptionRequest,
  type CompletePackingRequest, type ConfirmPickTaskRequest, type ConfirmPutawayRequest,
  type CreateWarehouseUnitRequest, type CurrentUserResponse, type HeartbeatRequest, type LoadPackageRequest,
  type PrintLabelRequest, type ReceiveGoodsRequest, type RegisterWarehouseLocationRequest,
  type ReportStockDiscrepancyRequest, type ResolveStockDiscrepancyRequest, type RunReconciliationRequest,
  type SetWarehouseLocationStatusRequest, type StagePackageRequest, type SubmitCycleCountRequest,
  type SyncOfflineConfirmationsRequest,
} from '@pss/contracts';
import { checkAccess, loadActiveRoleAssignments, requireAccess, type RoleAssignment } from '@pss/identity';
import { hashRequestBody, readIdempotencyKey, ZodValidationPipe } from '@pss/http';
import { IdempotencyError, runCommand, runCommandWithoutAudit } from '@pss/platform';
import { z } from 'zod';
import {
  activateWarehouse, addWarehouseUnitLine, allocatePickTask, assignException, completePacking,
  confirmPickTask, createWarehouseUnit, getActiveOperators, getExceptionQueue, getLocationUtilization,
  getNextWarehouseTask, getReconciliationResult, getWarehouseDashboard, getWarehouseReport,
  heartbeatOperatorSession, listWarehouseTasks, loadPackage, logException, printLabel, putawayStock,
  receiveGoods, registerWarehouseLocation, reportStockDiscrepancy, resolveException, resolveStockDiscrepancy,
  runReconciliation, setWarehouseLocationStatus, stagePackage, submitCycleCount, syncOfflineConfirmations,
} from '@pss/wms';
import { findProductByBarcode } from '@pss/master-data';
import { Pool, type PoolClient } from 'pg';
import { IdentityService } from './identity.controller';

type AuthedRequest = { headers: { authorization?: string; 'idempotency-key'?: string } };

/** RBAC-002: every registered role that can hold any warehouse-scoped WMS permission — used to gate read-only screens open to any of them. */
const WMS_READ_PERMISSIONS = ['wms.task.execute', 'wms.task.reassign', 'wms.count.review', 'wms.location.manage'] as const;

@Injectable()
export class WmsService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

  private requirePool(): Pool {
    if (!this.pool) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    return this.pool;
  }

  private actorOf(user: CurrentUserResponse, assignments: readonly RoleAssignment[]) {
    return { userId: user.id, roles: assignments.map((assignment) => assignment.roleCode) };
  }

  private async loadAssignments(user: CurrentUserResponse): Promise<RoleAssignment[]> {
    return loadActiveRoleAssignments(this.requirePool(), user.id);
  }

  private resourceOf(user: CurrentUserResponse, warehouseId: string | undefined) {
    return warehouseId ? { organizationId: user.organizationId, warehouseId } : { organizationId: user.organizationId };
  }

  /** RBAC-002: throws `PERMISSION_DENIED` unless the caller holds `permission` scoped to this warehouse. */
  private async requirePermission(user: CurrentUserResponse, permission: string, warehouseId: string | undefined): Promise<RoleAssignment[]> {
    const assignments = await this.loadAssignments(user);
    requireAccess({ actorId: user.id, organizationId: user.organizationId, assignments, permission, resource: this.resourceOf(user, warehouseId) });
    return assignments;
  }

  private async requireAnyPermission(user: CurrentUserResponse, permissions: readonly string[], warehouseId: string | undefined): Promise<RoleAssignment[]> {
    const assignments = await this.loadAssignments(user);
    const allowed = permissions.some((permission) =>
      checkAccess({ actorId: user.id, organizationId: user.organizationId, assignments, permission, resource: this.resourceOf(user, warehouseId) }));
    if (!allowed) throw new DomainError('PERMISSION_DENIED');
    return assignments;
  }

  private async warehouseIdOf(table: 'wms.warehouse_location' | 'wms.warehouse_task' | 'wms.stock_discrepancy_report' | 'wms.exception_queue' | 'wms.warehouse_unit', id: string): Promise<string> {
    const result = await this.requirePool().query<{ warehouse_id: string }>(`SELECT warehouse_id FROM ${table} WHERE id = $1`, [id]);
    const warehouseId = result.rows[0]?.warehouse_id;
    if (!warehouseId) throw new DomainError('NOT_FOUND');
    return warehouseId;
  }

  /** Same lookup, but never throws — used only where a missing referent must fall through to the domain command's own graceful handling (offline sync replay). */
  private async tryWarehouseIdOfTask(id: string): Promise<string | undefined> {
    const result = await this.requirePool().query<{ warehouse_id: string }>('SELECT warehouse_id FROM wms.warehouse_task WHERE id = $1', [id]);
    return result.rows[0]?.warehouse_id;
  }

  private async warehouseIdOfUnitCode(user: CurrentUserResponse, unitCode: string): Promise<string> {
    const result = await this.requirePool().query<{ warehouse_id: string }>(
      'SELECT warehouse_id FROM wms.warehouse_unit WHERE organization_id = $1 AND code = $2', [user.organizationId, unitCode],
    );
    const warehouseId = result.rows[0]?.warehouse_id;
    if (!warehouseId) throw new DomainError('NOT_FOUND');
    return warehouseId;
  }

  /**
   * PLT-006: every mutating `/gudang` or `/wms` command replays its stored response for a
   * previously-seen `(organizationId, identityId, commandName, key)` instead of re-executing.
   *
   * `runCommand` opens one transaction and requires `execute` to append an audit entry into it
   * (`AGENTS.md` §14), so a command that ignored the supplied client and opened its own
   * connection used to commit its effect outside the idempotency bookkeeping while still
   * reporting success. That was previously documented as accepted for `heartbeatOperatorSession`,
   * `assignException`, `resolveException`, and `syncOfflineConfirmations`; the audit guard now
   * rejects it, which is the point — those commands were the exception, not the rule.
   */
  /**
   * The audited wrapper. Prefer this; reach for `withoutAudit` only where the domain effect
   * cannot share the caller's transaction, and say which of the two qualifying shapes applies.
   */
  private async withIdempotency<T>(
    user: CurrentUserResponse, commandName: string, idempotencyKey: string, requestBody: unknown,
    execute: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await runCommand(
        this.requirePool(),
        { organizationId: user.organizationId, identityId: user.id, commandName, key: idempotencyKey, requestHash: hashRequestBody(requestBody) },
        async ({ client }) => ({ code: 200, body: await execute(client) }),
      );
      return result.body as T;
    } catch (error) {
      if (error instanceof IdempotencyError) throw new DomainError(error.code);
      throw error;
    }
  }

  /**
   * Key construction and error translation shared by the unaudited commands below. The command
   * itself is invoked inline rather than through a wrapper so that its justification is a string
   * literal at the call site, where `scripts/check-command-fitness.mjs` can require it. A wrapper
   * that forwarded a `reason` parameter made the justification invisible to the gate, which is
   * the same invisible exception the gate exists to prevent.
   */
  private unauditedKey(user: CurrentUserResponse, commandName: string, idempotencyKey: string, requestBody: unknown) {
    return {
      organizationId: user.organizationId, identityId: user.id, commandName,
      key: idempotencyKey, requestHash: hashRequestBody(requestBody),
    };
  }

  private rethrowIdempotency(error: unknown): never {
    if (error instanceof IdempotencyError) throw new DomainError(error.code);
    throw error;
  }

  async registerLocation(user: CurrentUserResponse, input: RegisterWarehouseLocationRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.location.manage', input.warehouseId);
    return this.withIdempotency(user, 'wms.registerLocation', idempotencyKey, input, (client) =>
      registerWarehouseLocation(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) }));
  }

  async setLocationStatus(user: CurrentUserResponse, locationId: string, input: SetWarehouseLocationStatusRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOf('wms.warehouse_location', locationId);
    const assignments = await this.requirePermission(user, 'wms.location.manage', warehouseId);
    return this.withIdempotency(user, 'wms.setLocationStatus', idempotencyKey, { locationId, ...input }, (client) =>
      setWarehouseLocationStatus(this.requirePool(), client, { locationId, status: input.status, actor: this.actorOf(user, assignments) }));
  }

  async activate(user: CurrentUserResponse, warehouseId: string, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.location.manage', warehouseId);
    return this.withIdempotency(user, 'wms.activate', idempotencyKey, { warehouseId }, (client) =>
      activateWarehouse(this.requirePool(), client, { organizationId: user.organizationId, warehouseId, actor: this.actorOf(user, assignments) }));
  }

  async receive(user: CurrentUserResponse, input: ReceiveGoodsRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    return this.withIdempotency(user, 'wms.receive', idempotencyKey, input, async (client) => {
      try {
        return await receiveGoods(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) });
      } catch (error) {
        await this.logLocationException(user, error, { warehouseId: input.warehouseId });
        throw error;
      }
    });
  }

  async confirmPutaway(user: CurrentUserResponse, taskId: string, input: ConfirmPutawayRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOf('wms.warehouse_task', taskId);
    const assignments = await this.requirePermission(user, 'wms.task.execute', warehouseId);
    return this.withIdempotency(user, 'wms.confirmPutaway', idempotencyKey, { taskId, ...input }, async (client) => {
      try {
        return await putawayStock(this.requirePool(), client, { taskId, ...input, actor: this.actorOf(user, assignments) });
      } catch (error) {
        await this.logLocationException(user, error, { taskId });
        throw error;
      }
    });
  }

  /**
   * WMS-000.R02: an operator scanning an unrecognized/blocked location is a real operational
   * problem worth surfacing on the exception queue, not just a rejected request. Callers pass
   * whichever of `warehouseId` (known upfront, e.g. `receiveGoods`) or `taskId` (looked up to find
   * its warehouse, e.g. `putawayStock`, which only takes a `taskId`) they have.
   */
  private async logLocationException(user: CurrentUserResponse, error: unknown, ref: { warehouseId?: string; taskId?: string }): Promise<void> {
    if (!(error instanceof DomainError) || !['NOT_FOUND', 'LOCATION_INVALID', 'LOCATION_UNAVAILABLE'].includes(error.code)) return;

    let warehouseId = ref.warehouseId;
    if (!warehouseId && ref.taskId) warehouseId = await this.tryWarehouseIdOfTask(ref.taskId);
    if (!warehouseId) return;

    await logException(this.requirePool(), {
      organizationId: user.organizationId, warehouseId, exceptionType: 'INVALID_LOCATION',
      referenceType: ref.taskId ? 'WAREHOUSE_TASK' : undefined, referenceId: ref.taskId,
      description: `Lokasi tidak valid (${error.code}).`, openedBy: user.id,
    });
  }

  async nextTask(user: CurrentUserResponse, warehouseId: string, type: 'RECEIVE' | 'PUTAWAY' | 'PICK' | 'COUNT') {
    await this.requirePermission(user, 'wms.task.execute', warehouseId);
    const task = await getNextWarehouseTask(this.requirePool(), { warehouseId, type, assigneeUserId: user.id });
    return { task };
  }

  /** Resolves a scanned barcode to a productId (same lookup `PosService.scan` uses) before the domain command's own mismatch check runs. */
  async confirmPick(user: CurrentUserResponse, taskId: string, input: ConfirmPickTaskRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOf('wms.warehouse_task', taskId);
    const assignments = await this.requirePermission(user, 'wms.task.execute', warehouseId);
    const scannedProductId = input.scannedProductId ?? await this.resolveBarcode(user, input.scannedBarcode!);
    return this.withIdempotency(user, 'wms.confirmPick', idempotencyKey, { taskId, ...input }, async (client) => {
      try {
        return await confirmPickTask(this.requirePool(), client, {
          taskId, scannedLocationCode: input.scannedLocationCode, scannedProductId,
          qtyConfirmed: input.qtyConfirmed, shortReasonCode: input.shortReasonCode, actor: this.actorOf(user, assignments),
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SCAN_MISMATCH') {
          await this.recordTaskException(user, 'SCAN_MISMATCH', taskId, 'Barcode yang discan tidak sesuai dengan tugas picking.');
        }
        throw error;
      }
    });
  }

  private async resolveBarcode(user: CurrentUserResponse, barcode: string): Promise<string> {
    const match = await findProductByBarcode(this.requirePool(), { organizationId: user.organizationId, barcode });
    if (!match) throw new DomainError('NOT_FOUND');
    return match.productId;
  }

  /**
   * WMS-005 — not part of the handheld BFF. Exposed as a directly-callable system endpoint until
   * a real `FULFILLMENT_RELEASED` consumer triggers it automatically.
   */
  async allocate(user: CurrentUserResponse, input: AllocatePickTaskRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    return this.withIdempotency(user, 'wms.allocate', idempotencyKey, input, async (client) => {
      const result = await allocatePickTask(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) });
      if (result.shortLines.length > 0) {
        await logException(this.requirePool(), {
          organizationId: user.organizationId, warehouseId: input.warehouseId, exceptionType: 'SHORT_ALLOCATION',
          referenceType: input.referenceType, referenceId: input.referenceId,
          description: `${result.shortLines.length} baris tidak dapat dialokasikan penuh.`, openedBy: user.id,
        });
      }
      return result;
    });
  }

  async submitCount(user: CurrentUserResponse, input: SubmitCycleCountRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    return this.withIdempotency(user, 'wms.submitCount', idempotencyKey, input, async (client) => {
      const result = await submitCycleCount(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) });
      if (result.varianceDetected) {
        await logException(this.requirePool(), {
          organizationId: user.organizationId, warehouseId: input.warehouseId, exceptionType: 'COUNT_VARIANCE',
          referenceType: 'WAREHOUSE_TASK', referenceId: result.taskId,
          description: 'Hasil hitung buta berbeda dari catatan sistem.', openedBy: user.id,
        });
      }
      return result;
    });
  }

  async reportDiscrepancy(user: CurrentUserResponse, input: ReportStockDiscrepancyRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    return this.withIdempotency(user, 'wms.reportDiscrepancy', idempotencyKey, input, async (client) => {
      const result = await reportStockDiscrepancy(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) });
      if (input.reportType === 'DAMAGED') {
        await logException(this.requirePool(), {
          organizationId: user.organizationId, warehouseId: input.warehouseId, exceptionType: 'DAMAGED_GOODS',
          referenceType: 'STOCK_DISCREPANCY_REPORT', referenceId: result.id,
          description: `Barang rusak dilaporkan (${input.qty} ${input.uom}).`, openedBy: user.id,
        });
      }
      return result;
    });
  }

  private async recordTaskException(user: CurrentUserResponse, exceptionType: 'SCAN_MISMATCH', taskId: string, description: string): Promise<void> {
    const warehouseId = await this.tryWarehouseIdOfTask(taskId);
    if (!warehouseId) return;
    await logException(this.requirePool(), {
      organizationId: user.organizationId, warehouseId, exceptionType, severity: 'HIGH',
      referenceType: 'WAREHOUSE_TASK', referenceId: taskId, description, openedBy: user.id,
    });
  }

  async resolveDiscrepancy(user: CurrentUserResponse, reportId: string, input: ResolveStockDiscrepancyRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOf('wms.stock_discrepancy_report', reportId);
    const assignments = await this.requirePermission(user, 'wms.count.review', warehouseId);
    return this.withIdempotency(user, 'wms.resolveDiscrepancy', idempotencyKey, { reportId, ...input }, (client) =>
      resolveStockDiscrepancy(this.requirePool(), client, { reportId, decision: input.decision, actor: this.actorOf(user, assignments) }));
  }

  async createUnit(user: CurrentUserResponse, input: CreateWarehouseUnitRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    return this.withIdempotency(user, 'wms.createUnit', idempotencyKey, input, (client) =>
      createWarehouseUnit(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) }));
  }

  async addUnitLine(user: CurrentUserResponse, unitCode: string, input: AddWarehouseUnitLineRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOfUnitCode(user, unitCode);
    const assignments = await this.requirePermission(user, 'wms.task.execute', warehouseId);
    return this.withIdempotency(user, 'wms.addUnitLine', idempotencyKey, { unitCode, ...input }, (client) =>
      addWarehouseUnitLine(this.requirePool(), client, { unitCode, ...input, actor: this.actorOf(user, assignments) }));
  }

  async completePacking(user: CurrentUserResponse, input: CompletePackingRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    return this.withIdempotency(user, 'wms.completePacking', idempotencyKey, input, (client) =>
      completePacking(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) }));
  }

  async stage(user: CurrentUserResponse, input: StagePackageRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOfUnitCode(user, input.unitCode);
    const assignments = await this.requirePermission(user, 'wms.task.execute', warehouseId);
    return this.withIdempotency(user, 'wms.stage', idempotencyKey, input, (client) =>
      stagePackage(this.requirePool(), client, { ...input, actor: this.actorOf(user, assignments) }));
  }

  async load(user: CurrentUserResponse, input: LoadPackageRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOfUnitCode(user, input.unitCode);
    const assignments = await this.requirePermission(user, 'wms.task.execute', warehouseId);
    return this.withIdempotency(user, 'wms.load', idempotencyKey, input, (client) =>
      loadPackage(this.requirePool(), client, { ...input, actor: this.actorOf(user, assignments) }));
  }

  async printLabel(user: CurrentUserResponse, input: PrintLabelRequest, idempotencyKey: string) {
    const warehouseId = input.subjectType === 'LOCATION'
      ? await this.warehouseIdOf('wms.warehouse_location', input.subjectId)
      : await this.warehouseIdOf('wms.warehouse_unit', input.subjectId);
    const assignments = await this.requirePermission(user, 'wms.task.execute', warehouseId);
    return this.withIdempotency(user, 'wms.printLabel', idempotencyKey, input, (client) =>
      printLabel(this.requirePool(), client, { ...input, actor: this.actorOf(user, assignments) }));
  }

  async runReconciliation(user: CurrentUserResponse, input: RunReconciliationRequest, idempotencyKey: string) {
    const assignments = await this.requirePermission(user, 'wms.count.review', input.warehouseId);
    return this.withIdempotency(user, 'wms.runReconciliation', idempotencyKey, input, (client) =>
      runReconciliation(this.requirePool(), client, { organizationId: user.organizationId, ...input, actor: this.actorOf(user, assignments) }));
  }

  async getReconciliation(user: CurrentUserResponse, warehouseId: string, businessDate: string) {
    await this.requirePermission(user, 'wms.count.review', warehouseId);
    return getReconciliationResult(this.requirePool(), { warehouseId, businessDate });
  }

  async getDashboard(user: CurrentUserResponse, warehouseId: string) {
    await this.requireAnyPermission(user, WMS_READ_PERMISSIONS, warehouseId);
    return getWarehouseDashboard(this.requirePool(), { warehouseId });
  }

  /**
   * WMS-014 offline replay — a batch may reference tasks across the operator's own shift only, but
   * a queued item can outlive the task it named (e.g. reassigned or cancelled while offline); a
   * missing referent is left for `confirmPickTask`/`putawayStock`'s own per-item `NEEDS_REVIEW`
   * handling rather than aborting the whole batch on a permission pre-check.
   */
  async syncOffline(user: CurrentUserResponse, input: SyncOfflineConfirmationsRequest, idempotencyKey: string) {
    const assignments = await this.loadAssignments(user);
    const taskIds = [...new Set(input.confirmations.map((confirmation) => confirmation.taskId))];
    for (const taskId of taskIds) {
      const warehouseId = await this.tryWarehouseIdOfTask(taskId);
      if (!warehouseId) continue;
      requireAccess({ actorId: user.id, organizationId: user.organizationId, assignments, permission: 'wms.task.execute', resource: { organizationId: user.organizationId, warehouseId } });
    }
    try {
      const result = await runCommandWithoutAudit(
        this.requirePool(),
        this.unauditedKey(user, 'wms.syncOffline', idempotencyKey, input),
        async () => ({ code: 200, body: await syncOfflineConfirmations(this.requirePool(), { actor: this.actorOf(user, assignments), confirmations: input.confirmations }) }),
        'Batch: each confirmation commits independently so one rejected scan becomes NEEDS_REVIEW instead of discarding the device queue.',
      );
      return result.body;
    } catch (error) { this.rethrowIdempotency(error); }
  }

  async heartbeat(user: CurrentUserResponse, input: HeartbeatRequest, idempotencyKey: string) {
    await this.requirePermission(user, 'wms.task.execute', input.warehouseId);
    try {
      const result = await runCommandWithoutAudit(
        this.requirePool(),
        this.unauditedKey(user, 'wms.heartbeat', idempotencyKey, input),
        async () => ({ code: 200, body: await heartbeatOperatorSession(this.requirePool(), { organizationId: user.organizationId, warehouseId: input.warehouseId, userId: user.id, currentTaskId: input.currentTaskId }) }),
        'Presence telemetry: the heartbeat records that an operator is still on a task; no aggregate state changes.',
      );
      return result.body as { ok: true };
    } catch (error) { this.rethrowIdempotency(error); }
  }

  async getActiveOperators(user: CurrentUserResponse, warehouseId: string) {
    await this.requireAnyPermission(user, WMS_READ_PERMISSIONS, warehouseId);
    const operators = await getActiveOperators(this.requirePool(), { warehouseId });
    return { operators };
  }

  async getExceptionQueue(user: CurrentUserResponse, warehouseId: string, status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED') {
    await this.requireAnyPermission(user, WMS_READ_PERMISSIONS, warehouseId);
    const items = await getExceptionQueue(this.requirePool(), { warehouseId, status });
    return { items };
  }

  async assignException(user: CurrentUserResponse, id: string, input: AssignExceptionRequest, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOf('wms.exception_queue', id);
    await this.requirePermission(user, 'wms.task.reassign', warehouseId);
    try {
      const result = await runCommandWithoutAudit(
        this.requirePool(),
        this.unauditedKey(user, 'wms.assignException', idempotencyKey, { id, ...input }),
        async () => ({ code: 200, body: await assignException(this.requirePool(), { id, assignedTo: input.assignedTo }) }),
        'Queue bookkeeping: assignment is a triage state on the ticket, not a change to a business aggregate.',
      );
      return result.body as { id: string };
    } catch (error) { this.rethrowIdempotency(error); }
  }

  async resolveException(user: CurrentUserResponse, id: string, idempotencyKey: string) {
    const warehouseId = await this.warehouseIdOf('wms.exception_queue', id);
    await this.requirePermission(user, 'wms.count.review', warehouseId);
    try {
      const result = await runCommandWithoutAudit(
        this.requirePool(),
        this.unauditedKey(user, 'wms.resolveException', idempotencyKey, { id }),
        async () => ({ code: 200, body: await resolveException(this.requirePool(), { id }) }),
        'Queue bookkeeping: closing the ticket is triage state; the underlying correction was already audited when it happened.',
      );
      return result.body as { id: string };
    } catch (error) { this.rethrowIdempotency(error); }
  }

  async getLocationUtilization(user: CurrentUserResponse, warehouseId: string) {
    await this.requireAnyPermission(user, WMS_READ_PERMISSIONS, warehouseId);
    const locations = await getLocationUtilization(this.requirePool(), { warehouseId });
    return { locations };
  }

  async getWarehouseReport(user: CurrentUserResponse, warehouseId: string, fromDate: string, toDate: string) {
    await this.requireAnyPermission(user, WMS_READ_PERMISSIONS, warehouseId);
    return getWarehouseReport(this.requirePool(), { warehouseId, fromDate, toDate });
  }

  async listWarehouseTasks(
    user: CurrentUserResponse,
    warehouseId: string,
    type?: 'RECEIVE' | 'PUTAWAY' | 'PICK' | 'COUNT' | 'PACK' | 'STAGE' | 'LOAD',
    status?: 'CREATED' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_SHORT' | 'CANCELLED',
    limit?: number,
  ) {
    await this.requireAnyPermission(user, WMS_READ_PERMISSIONS, warehouseId);
    const tasks = await listWarehouseTasks(this.requirePool(), { warehouseId, type, status, limit });
    return { tasks };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * `/wms/*` (back-office setup: locations, activation, discrepancy resolution) and `/gudang/*`
 * (PSS Gudang handheld BFF per §42) — every write resolves the acting user from the session
 * (never trusts a client-supplied organizationId), same pattern as `PosController`/`IdentityController`.
 * RBAC-002: every route checks the caller's warehouse-scoped role assignments via `@pss/identity`'s
 * `checkAccess`/`requireAccess`. PLT-006: every mutating route requires and replays on a client
 * `Idempotency-Key` header via `@pss/platform`'s `withIdempotentCommand`.
 */
@Controller()
export class WmsController {
  constructor(
    @Inject(WmsService) private readonly wms: WmsService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private currentUser(request: AuthedRequest): Promise<CurrentUserResponse> {
    return this.identity.getCurrentUser(request.headers.authorization);
  }

  private idempotencyKey(request: AuthedRequest): string {
    return readIdempotencyKey(request as never);
  }

  @Post('wms/locations')
  async registerLocation(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(RegisterWarehouseLocationRequestSchema)) body: RegisterWarehouseLocationRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.registerLocation(user, body, idempotencyKey);
  }

  @Post('wms/locations/:id/status')
  async setLocationStatus(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) locationId: string, @Body(new ZodValidationPipe(SetWarehouseLocationStatusRequestSchema)) body: SetWarehouseLocationStatusRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.setLocationStatus(user, locationId, body, idempotencyKey);
  }

  @Post('wms/warehouses/:id/activate')
  async activate(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) warehouseId: string) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.activate(user, warehouseId, idempotencyKey);
  }

  @Post('wms/discrepancies/:id/resolve')
  async resolveDiscrepancy(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) reportId: string, @Body(new ZodValidationPipe(ResolveStockDiscrepancyRequestSchema)) body: ResolveStockDiscrepancyRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.resolveDiscrepancy(user, reportId, body, idempotencyKey);
  }

  @Post('wms/allocations')
  async allocate(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(AllocatePickTaskRequestSchema)) body: AllocatePickTaskRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.allocate(user, body, idempotencyKey);
  }

  @Post('gudang/terima')
  async receive(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(ReceiveGoodsRequestSchema)) body: ReceiveGoodsRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.receive(user, body, idempotencyKey);
  }

  @Post('gudang/putaway/:id/konfirmasi')
  async confirmPutaway(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) taskId: string, @Body(new ZodValidationPipe(ConfirmPutawayRequestSchema)) body: ConfirmPutawayRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.confirmPutaway(user, taskId, body, idempotencyKey);
  }

  @Get('gudang/tugas-berikutnya')
  async nextTask(
    @Req() request: AuthedRequest,
    @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string,
    @Query('type', new ZodValidationPipe(WarehouseTaskTypeSchema)) type: 'RECEIVE' | 'PUTAWAY' | 'PICK' | 'COUNT',
  ) {
    const user = await this.currentUser(request);
    const result = await this.wms.nextTask(user, warehouseId, type);
    return NextWarehouseTaskResponseSchema.parse(result);
  }

  @Post('gudang/tugas/:id/konfirmasi')
  async confirmPick(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) taskId: string, @Body(new ZodValidationPipe(ConfirmPickTaskRequestSchema)) body: ConfirmPickTaskRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.confirmPick(user, taskId, body, idempotencyKey);
  }

  @Post('gudang/hitung')
  async submitCount(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(SubmitCycleCountRequestSchema)) body: SubmitCycleCountRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.submitCount(user, body, idempotencyKey);
  }

  @Post('gudang/masalah')
  async reportDiscrepancy(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(ReportStockDiscrepancyRequestSchema)) body: ReportStockDiscrepancyRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.reportDiscrepancy(user, body, idempotencyKey);
  }

  @Post('wms/units')
  async createUnit(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(CreateWarehouseUnitRequestSchema)) body: CreateWarehouseUnitRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.createUnit(user, body, idempotencyKey);
  }

  @Post('gudang/koli/:code/scan')
  async addUnitLine(@Req() request: AuthedRequest, @Param('code') unitCode: string, @Body(new ZodValidationPipe(AddWarehouseUnitLineRequestSchema)) body: AddWarehouseUnitLineRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.addUnitLine(user, unitCode, body, idempotencyKey);
  }

  @Post('gudang/koli/selesai')
  async completePacking(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(CompletePackingRequestSchema)) body: CompletePackingRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.completePacking(user, body, idempotencyKey);
  }

  @Post('gudang/stage')
  async stage(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(StagePackageRequestSchema)) body: StagePackageRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.stage(user, body, idempotencyKey);
  }

  @Post('gudang/load')
  async load(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(LoadPackageRequestSchema)) body: LoadPackageRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.load(user, body, idempotencyKey);
  }

  @Post('wms/labels/print')
  async printLabel(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(PrintLabelRequestSchema)) body: PrintLabelRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.printLabel(user, body, idempotencyKey);
  }

  @Post('wms/reconciliation')
  async runReconciliation(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(RunReconciliationRequestSchema)) body: RunReconciliationRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.runReconciliation(user, body, idempotencyKey);
  }

  @Get('wms/reconciliation')
  async getReconciliation(@Req() request: AuthedRequest, @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string, @Query('date', new ZodValidationPipe(z.iso.date())) date: string) {
    const user = await this.currentUser(request);
    const result = await this.wms.getReconciliation(user, warehouseId, date);
    return result ? ReconciliationResultResponseSchema.parse(result) : null;
  }

  @Get('wms/dashboard')
  async getDashboard(@Req() request: AuthedRequest, @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string) {
    const user = await this.currentUser(request);
    const result = await this.wms.getDashboard(user, warehouseId);
    return WarehouseDashboardResponseSchema.parse(result);
  }

  @Post('gudang/sync')
  async syncOffline(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(SyncOfflineConfirmationsRequestSchema)) body: SyncOfflineConfirmationsRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.syncOffline(user, body, idempotencyKey);
  }

  @Post('gudang/heartbeat')
  async heartbeat(@Req() request: AuthedRequest, @Body(new ZodValidationPipe(HeartbeatRequestSchema)) body: HeartbeatRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.heartbeat(user, body, idempotencyKey);
  }

  @Get('wms/operators/active')
  async getActiveOperators(@Req() request: AuthedRequest, @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string) {
    const user = await this.currentUser(request);
    return this.wms.getActiveOperators(user, warehouseId);
  }

  @Get('wms/exceptions')
  async getExceptionQueue(
    @Req() request: AuthedRequest,
    @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string,
    @Query('status', new ZodValidationPipe(z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional())) status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED',
  ) {
    const user = await this.currentUser(request);
    return this.wms.getExceptionQueue(user, warehouseId, status);
  }

  @Post('wms/exceptions/:id/assign')
  async assignException(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) id: string, @Body(new ZodValidationPipe(AssignExceptionRequestSchema)) body: AssignExceptionRequest) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.assignException(user, id, body, idempotencyKey);
  }

  @Post('wms/exceptions/:id/resolve')
  async resolveException(@Req() request: AuthedRequest, @Param('id', new ZodValidationPipe(z.uuid())) id: string) {
    const idempotencyKey = this.idempotencyKey(request);
    const user = await this.currentUser(request);
    return this.wms.resolveException(user, id, idempotencyKey);
  }

  @Get('wms/locations/utilization')
  async getLocationUtilization(@Req() request: AuthedRequest, @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string) {
    const user = await this.currentUser(request);
    return this.wms.getLocationUtilization(user, warehouseId);
  }

  @Get('wms/reports')
  async getWarehouseReport(
    @Req() request: AuthedRequest,
    @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string,
    @Query('from', new ZodValidationPipe(z.iso.date())) from: string,
    @Query('to', new ZodValidationPipe(z.iso.date())) to: string,
  ) {
    const user = await this.currentUser(request);
    return this.wms.getWarehouseReport(user, warehouseId, from, to);
  }

  @Get('wms/tasks')
  async listWarehouseTasks(
    @Req() request: AuthedRequest,
    @Query('warehouseId', new ZodValidationPipe(z.uuid())) warehouseId: string,
    @Query('type', new ZodValidationPipe(WarehouseTaskTypeSchema.optional())) type?: 'RECEIVE' | 'PUTAWAY' | 'PICK' | 'COUNT' | 'PACK' | 'STAGE' | 'LOAD',
    @Query('status', new ZodValidationPipe(WarehouseTaskStatusSchema.optional())) status?: 'CREATED' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'COMPLETED_SHORT' | 'CANCELLED',
    @Query('limit', new ZodValidationPipe(z.coerce.number().int().positive().max(500).optional())) limit?: number,
  ) {
    const user = await this.currentUser(request);
    return this.wms.listWarehouseTasks(user, warehouseId, type, status, limit);
  }
}
