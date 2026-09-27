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
  'SYS-ADMIN': [
    'identity.user.manage', 'identity.role.assign', 'identity.session.revoke',
    'identity.mfa.reset', 'identity.device.revoke', 'integration.connector.manage',
  ],
  'AUDIT-READ-ALL': ['audit.entry.read', 'audit.export'],
};

export interface RolePermissions {
  permissions: string[];
  unresolvedGroups: string[];
}

export function resolveRolePermissions(roleCode: string): RolePermissions {
  const role = registryCatalog.roles.find((entry) => entry.code === roleCode);
  if (!role) return { permissions: [], unresolvedGroups: [] };
  const groups = role.permissionGroups.split(',').map((group) => group.trim());
  return {
    permissions: [...new Set(groups.flatMap((group) => groupPermissions[group] ?? []))].sort(),
    unresolvedGroups: groups.filter((group) => !(group in groupPermissions)),
  };
}

export function isRegisteredRole(roleCode: string): boolean {
  return registryCatalog.roles.some((role) => role.code === roleCode);
}
