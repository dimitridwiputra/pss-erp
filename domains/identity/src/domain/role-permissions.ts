import { registryCatalog } from '@pss/contracts';

// Concrete grants transcribed from PRD Appendix D.2/D.3. A composite or
// unspecified group never expands to a wildcard or a neighbouring action.
const groupPermissions: Readonly<Record<string, readonly string[]>> = {
  'SFA-EXEC': ['sfa.visit.execute', 'sfa.prospect.create', 'sfa.photo.create', 'geo.location.capture'],
  'ORD-REQ': ['orders.order_request.submit', 'commercial.price.view', 'credit.precheck.view'],
  'COL-FIELD': ['payments.evidence.record'],
  'COL-COD': ['payments.evidence.record'],
  'CSH-DECLARE': ['payments.cash_handover.declare'],
  'SFA-SUPERVISE': ['sfa.visit_plan.manage', 'sfa.team.view'],
  'CUS-PROSPECT-APPROVE': ['master_data.prospect.approve'],
  'ORD-MANAGE': ['orders.order.create', 'orders.order.confirm', 'orders.order.resolve_shortage', 'orders.duplicate.resolve'],
  'ORD-CANCEL': ['orders.order.cancel'],
  'FUL-PREPARE': ['fulfillment.request.prepare', 'fulfillment.delivery_order.dispatch'],
  'FUL-DELIVERY-CONFIRM': ['fulfillment.delivery_order.confirm_delivery'],
  'COM-PRICE': ['commercial.price_list.manage'],
  'COM-OVERRIDE-L1': ['commercial.price.override'],
  'COM-OVERRIDE-L2': ['commercial.price.override'],
  'CRD-OVERRIDE-L1': ['credit.override.approve'],
  'CRD-OVERRIDE-L2': ['credit.override.approve'],
  'PRI-POLICY-REQUEST': ['principal_policy.policy.propose'],
  'INV-ADJ-REQUEST': ['inventory.adjustment.request'],
  'INV-ADJ-APPROVE-L1': ['inventory.adjustment.approve'],
  'INV-COUNT': ['inventory.count.execute'],
  'INV-TRANSFER': ['inventory.transfer.manage'],
  'PUR-MANAGE': ['procurement.po.manage'],
  'PUR-RECEIVE': ['procurement.receipt.post'],
  'PUR-APPROVE-L2': ['procurement.po.approve'],
  'RET-REQUEST': ['returns.return.request'],
  'RET-APPROVE': ['returns.return.approve'],
  'RET-RECEIVE': ['returns.return.receive'],
  'RET-CREDIT-NOTE': ['returns.credit_note.issue'],
  'PAY-RECORD': ['payments.payment.record'],
  'PAY-VERIFY': ['payments.payment.verify'],
  'PAY-APPLY': ['payments.payment.apply'],
  'PAY-REVERSAL-APPROVE': ['payments.application.reverse.approve'],
  'CSH-VERIFY': ['payments.cash_custody.verify'],
  'CSH-DISCREPANCY-APPROVE': ['payments.cash_custody.discrepancy.approve'],
  'AR-MANAGE': ['ar.dispute.manage', 'ar.collection_task.assign'],
  'COL-ASSIGN': ['ar.collection_task.assign'],
  'AR-WO-REQUEST': ['ar.write_off.request'],
  'AR-WO-APPROVE': ['ar.write_off.approve'],
  'AP-MANAGE': ['ap.payment.prepare'],
  'AP-PAY-APPROVE': ['ap.payment.approve'],
  'GL-MAKE': ['finance.journal.create', 'finance.journal.submit', 'finance.journal.reverse.request'],
  'GL-APPROVE': ['finance.journal.approve'],
  'GL-PERIOD-DECISION': ['finance.posting.period_decision'],
  'CLS-MANAGE': ['finance.close.manage', 'finance.period.reopen.request'],
  'CLS-APPROVE': ['finance.close.approve'],
  'CLS-REOPEN-APPROVE': ['finance.period.reopen.approve'],
  'BNK-RECON': ['finance.bank.import', 'finance.bank.reconcile'],
  'BNK-PETTY-EXEC': ['finance.petty_cash.expense.record'],
  'TAX-MANAGE': ['tax.rate.manage', 'tax.invoice_number.manage', 'tax.export.run'],
  'FIN-CONFIG': ['finance.coa.manage', 'finance.posting_rule.manage', 'finance.account_role.map'],
  'INT-MAP': ['integration.mapping.decide'],
  'INT-OPERATE': ['integration.batch.retry', 'integration.file.upload', 'integration.raw.view'],
  // POS-EXEC's source text ends "(bila `pos.credit_sale` aktif)": `pos.credit_sale` is the feature
  // flag gating the request permission, not a permission, so it is not transcribed.
  'POS-EXEC': [
    'pos.shift.open', 'pos.shift.close', 'pos.sale.create', 'pos.sale.checkout', 'pos.tender.accept',
    'pos.customer.quick_register', 'pos.receipt.reprint', 'pos.credit_sale.request',
  ],
  'POS-SUPERVISE': [
    'pos.terminal.manage', 'pos.shift.force_close', 'pos.shift.review', 'pos.sale.cancel.approve',
    'pos.tender.void.approve', 'pos.transfer.release.approve', 'pos.offline.activate', 'pos.report.view',
  ],
  'WMS-EXEC': ['wms.task.execute'],
  'WMS-SUPERVISE': ['wms.task.reassign'],
  'WMS-COUNT-REVIEW': ['wms.count.review'],
  'WMS-CONFIG': ['wms.location.manage'],
  'FLT-PLAN': ['fleet.shipment.plan'],
  'FLT-DISPATCH': ['fleet.shipment.dispatch'],
  'FLT-VEHICLE': ['fleet.vehicle.manage'],
  'DLV-EXEC': ['fleet.delivery.execute'],
  'GEO-ADMIN': ['geo.dataset.load', 'geo.territory.manage'],
  'CST-VIEW': ['reporting.control_station.view'],
  'CST-VIEW-TEAM': ['reporting.control_station.view'],
  'FLT-SUPERVISE': ['fleet.shipment.view'],
  'MDM-MERGE-REQUEST': ['master_data.merge.request'],
  'DQ-WORK': ['platform.exception.work'],
  // `configuration.*.manage` from Appendix D.3 is deliberately NOT transcribed as a wildcard.
  // The owner decided SYSTEM_ADMIN may manage TECHNICAL configuration and that business
  // configuration is proposed by the configured owner role for each key. A wildcard would grant
  // blanket business reach and would make SOD-07 unsatisfiable, because holding a business
  // mutation role is a hard violation with no exception path. The concrete technical permission
  // is transcribed here; the per-key business owner is data in platform.config_key, resolved by
  // evaluateConfigWrite rather than by a static permission list.
  'SYS-ADMIN': [
    'identity.user.manage', 'identity.role.assign', 'identity.session.revoke',
    'identity.mfa.reset', 'identity.device.revoke', 'integration.connector.manage',
    'configuration.technical.manage',
  ],
  'AUDIT-READ-ALL': ['audit.entry.read', 'audit.export'],
};

/**
 * Grants a feature spec names for a role without a group in the Appendix D.1 role row. Each entry
 * cites the spec line; none is inferred.
 *   - POS-014 "RBAC / SCOPE: CSH-DECLARE (POS_CASHIER)" — the counter cashier declares the shift's
 *     cash handover. The D.1 row for POS_CASHIER lists only POS-EXEC (MVP_PLAN §10, MVP-OD-7).
 *   - Appendix D additions §46A and POS-010 "RBAC / SCOPE": `fulfillment.pickup.handover`
 *     (WAREHOUSE_ADMIN, WAREHOUSE_OPERATOR).
 */
const roleAdditionalGroups: Readonly<Record<string, readonly string[]>> = {
  POS_CASHIER: ['CSH-DECLARE'],
};
const roleAdditionalPermissions: Readonly<Record<string, readonly string[]>> = {
  WAREHOUSE_ADMIN: ['fulfillment.pickup.handover'],
  WAREHOUSE_OPERATOR: ['fulfillment.pickup.handover'],
};

export interface RolePermissions {
  permissions: string[];
  unresolvedGroups: string[];
}

export function resolveRolePermissions(roleCode: string): RolePermissions {
  const role = registryCatalog.roles.find((entry) => entry.code === roleCode);
  if (!role) return { permissions: [], unresolvedGroups: [] };
  const groups = [
    ...role.permissionGroups.split(',').map((group) => group.trim()),
    ...(roleAdditionalGroups[roleCode] ?? []),
  ];
  return {
    permissions: [...new Set([
      ...groups.flatMap((group) => groupPermissions[group] ?? []),
      ...(roleAdditionalPermissions[roleCode] ?? []),
    ])].sort(),
    unresolvedGroups: groups.filter((group) => !(group in groupPermissions)),
  };
}

export function isRegisteredRole(roleCode: string): boolean {
  return registryCatalog.roles.some((role) => role.code === roleCode);
}
