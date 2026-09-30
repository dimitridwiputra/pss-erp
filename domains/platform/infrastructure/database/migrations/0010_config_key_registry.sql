-- PLT-009 configuration key registry.
--
-- Why this table exists: `proposeConfigValue` used to take `requiresOwnerApproval` from the HTTP
-- caller, which meant the caller decided whether a change needed approval. That is the wrong
-- direction for a control — a client could simply assert `false`. Appendix N lists the
-- configuration keys but never records which are sensitive, so there was no authoritative source to
-- check against, and no value could move out of PENDING_APPROVAL because nothing ever opened an
-- approval.
--
-- This table is that source. It is deliberately DATA, not code, so reclassifying a key is a write
-- rather than a deploy, and so the decision is auditable: the classification, the owner role, and
-- the approval level are all visible in one table rather than spread across a permission list and a
-- controller.
--
-- Scope: the table is GLOBAL, not per organization. A key's meaning does not change between
-- tenants, and a per-organization copy would let one tenant downgrade a control that applies to
-- all of them. Values remain per-organization in platform.config_value.
--
-- Column notes:
--   classification  TECHNICAL is a platform behaviour a system administrator legitimately owns.
--                   BUSINESS changes a business outcome and belongs to a named owner role.
--                   This is the split that lets SYSTEM_ADMIN manage configuration without
--                   acquiring general business-mutation authority (AGENTS.md 15, SOD-07).
--   sensitivity     SENSITIVE routes through the config_change approval. ROUTINE takes effect
--                   on schedule. A control that can rewrite who must approve it is SENSITIVE by
--                   necessity, not by the money/tax/credit test.
--   owner_role_code Who may PROPOSE a change to this key. Null only for a TECHNICAL key, whose
--                   proposer is decided by holding configuration.technical.manage instead.
--   approval_level  The level to route to. NULL means "not yet decided for this key", which
--                   requestApproval resolves to the HIGHEST level in the policy. The owner
--                   decided this explicitly rather than defaulting to the lowest, because a
--                   control that starts at the most senior authority and is relaxed
--                   deliberately is safer than one that starts permissive.
--
-- Forward-only. No existing table is altered, so this can be applied with no downtime and rolled
-- back by dropping this table alone.

CREATE TABLE IF NOT EXISTS platform.config_key (
  key text PRIMARY KEY,
  classification text NOT NULL CHECK (classification IN ('TECHNICAL', 'BUSINESS')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('SENSITIVE', 'ROUTINE')),
  owner_role_code text,
  approval_level smallint CHECK (approval_level IS NULL OR approval_level BETWEEN 1 AND 3),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A BUSINESS key must name its owner; a TECHNICAL key is owned by the technical permission.
  CHECK (classification = 'TECHNICAL' OR owner_role_code IS NOT NULL),
  -- Only a BUSINESS key can be routed to a business owner role.
  CHECK (classification = 'BUSINESS' OR owner_role_code IS NULL)
);

COMMENT ON TABLE platform.config_key IS
  'Authoritative classification of every configuration key: who may propose a change, and whether it needs approval. Global, not per organization.';
COMMENT ON COLUMN platform.config_key.approval_level IS
  'NULL routes to the highest level in the active approval policy. Not the same as level 1.';

-- ------------------------------------------------------------------------------------------------
-- config_change approval type.
--
-- The PRD routes a sensitive key to a config_change approval, but no such type existed, so no
-- configuration value could leave PENDING_APPROVAL. Registered here with its policy and two levels.
--
-- expiry_hours 72: a configuration change left pending three days is stale by the time anyone
--   decides it. The requester re-proposes rather than an approver acting on old intent.
-- delegation_allowed true: otherwise one departing approver strands every sensitive change.
-- reason_required true: AGENTS.md 14 requires a reason on this class of change.
--
-- Level 1 is the business owner level and level 2 the most senior. Every seeded key has a NULL
-- approval_level, so requestApproval routes to level 2 until a specific level is configured per
-- key — the fail-safe direction the owner chose, not an auto-approve.
INSERT INTO platform.approval_type (code, owner_domain, subject_type, expiry_hours, delegation_allowed, reason_required)
VALUES ('config_change', 'platform', 'ConfigValue', 72, true, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.approval_policy (id, type_code, effective_from, status)
VALUES ('00000000-0000-4000-8000-00000000c0f1', 'config_change', DATE '2026-01-01', 'ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code, max_amount)
VALUES
  ('00000000-0000-4000-8000-00000000c0f1', 1, 'FINANCE_APPROVER', 'approval.config_change.decide', NULL),
  ('00000000-0000-4000-8000-00000000c0f1', 2, 'CFO',            'approval.config_change.decide', NULL)
ON CONFLICT DO NOTHING;

-- PLT-009 key classification seed. GENERATED, not hand-maintained.
-- `pnpm config-keys:seed` derives these rows from the same generated registry the runtime reads,
-- and `--check` runs in CI, so a key added to Appendix N cannot be left unclassified — which is
-- the failure that made the write path unreachable in the first place.
--
-- Three rules, in order:
--   TECHNICAL  a platform behaviour a system administrator legitimately owns: the integration,
--              retention, event, backup, migration, media, notification, and platform
--              namespaces. No technical key may be SENSITIVE — the generator throws if one is,
--              so a key in a technical namespace that changes money must be classified
--              deliberately rather than swept up by a prefix.
--   SENSITIVE  changes money owed, tax computed, or credit exposure. Routed through the
--              config_change approval, to the HIGHEST level until a per-key level is set.
--   ROUTINE    everything else; takes effect on schedule.
--
-- The owner role is per namespace, taken from the roles Appendix D.1 already registers. A key
-- with no namespace owner is a generator error rather than a silently unowned key.
--
-- Reclassifying one key: change the rule in scripts/generate-config-key-seed.mjs and re-run. Do
-- not edit the rows below, and do not reclassify in the database without recording why.

INSERT INTO platform.config_key (key, classification, sensitivity, owner_role_code, description) VALUES
  ('api.rate_limits', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi API: rate limits.'),
  ('audit.hot_months', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Audit: hot months.'),
  ('audit.retention_years', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Audit: retention years.'),
  ('backup.pitr_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Backup: pitr days.'),
  ('documents.reservation_timeout_minutes', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Dokumen: reservation timeout minutes.'),
  ('dwh.retirement_grace_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Data Warehouse: retirement grace days.'),
  ('events.archive_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Event: archive days.'),
  ('events.dlq_alert_minutes', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Event: dlq alert minutes.'),
  ('events.retry_backoff', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Event: retry backoff.'),
  ('idempotency.retention_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Idempotensi: retention days.'),
  ('integration.allow_manual_pending_match', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: allow manual pending match.'),
  ('integration.auto_rule_match', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: auto rule match.'),
  ('integration.dependency_retry_hours', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: dependency retry hours.'),
  ('integration.duplicate_amount_tolerance', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: duplicate amount tolerance.'),
  ('integration.expected_file_interval_hours', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: expected file interval hours.'),
  ('integration.fingerprint_amount_tolerance', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: fingerprint amount tolerance.'),
  ('integration.freshness_sla_minutes', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: freshness sla minutes.'),
  ('integration.max_file_mb', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: max file mb.'),
  ('integration.outbound_enabled', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: outbound enabled.'),
  ('integration.parallel_run_tolerance', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: parallel run tolerance.'),
  ('integration.pending_mapping_max_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: pending mapping max days.'),
  ('integration.pending_match_max_hours', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: pending match max hours.'),
  ('integration.raw_retention_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: raw retention days.'),
  ('integration.recon_tolerance', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: recon tolerance.'),
  ('integration.retry_backoff_minutes', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Integrasi: retry backoff minutes.'),
  ('media.max_image_kb', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Media: max image kb.'),
  ('media.url_ttl_seconds', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Media: url ttl seconds.'),
  ('migration.emergency_rollback', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Migrasi: emergency rollback.'),
  ('migration.parallel_run_days_required', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Migrasi: parallel run days required.'),
  ('notifications.external_channels', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Notifikasi: external channels.'),
  ('notifications.retention_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Notifikasi: retention days.'),
  ('observability.log_retention_days', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Observability: log retention days.'),
  ('offline.max_age_hours', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Offline: max age hours.'),
  ('offline.max_retry', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Offline: max retry.'),
  ('platform.business_calendar', 'TECHNICAL', 'ROUTINE', NULL, 'Konfigurasi Platform: business calendar.'),
  ('ar.aging_buckets', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Piutang: aging buckets.'),
  ('ar.block_on_write_off', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Piutang: block on write off.'),
  ('ar.collection_task_expiry_days', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Piutang: collection task expiry days.'),
  ('ar.collection_task_rule', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Piutang: collection task rule.'),
  ('ar.dispute_sla_days', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Piutang: dispute sla days.'),
  ('ar.overdue_tolerance_days', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Piutang: overdue tolerance days.'),
  ('credit.auto_release_on_payment', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: auto release on payment.'),
  ('credit.auto_request_override', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: auto request override.'),
  ('credit.hold_expiry_hours', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: hold expiry hours.'),
  ('credit.include_open_orders_in_exposure', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: include open orders in exposure.'),
  ('credit.include_pending_giro_in_exposure', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: include pending giro in exposure.'),
  ('credit.revalidate_after_minutes', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: revalidate after minutes.'),
  ('credit.show_limit_to_sales', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: show limit to sales.'),
  ('credit.sub_limit_enabled', 'BUSINESS', 'SENSITIVE', 'AR_OFFICER', 'Konfigurasi Kredit: sub limit enabled.'),
  ('approval.cash_discrepancy.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: cash discrepancy.levels.'),
  ('approval.credit_override.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: credit override.levels.'),
  ('approval.credit_profile_change.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: credit profile change.levels.'),
  ('approval.journal.expiry_days', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: journal.expiry days.'),
  ('approval.journal.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: journal.levels.'),
  ('approval.period_reopen.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: period reopen.levels.'),
  ('approval.price_list_activation.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: price list activation.levels.'),
  ('approval.price_override.expiry_hours', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: price override.expiry hours.'),
  ('approval.price_override.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: price override.levels.'),
  ('approval.stock_adjustment.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: stock adjustment.levels.'),
  ('approval.supplier_payment.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: supplier payment.levels.'),
  ('approval.write_off.levels', 'BUSINESS', 'SENSITIVE', 'CFO', 'Konfigurasi Persetujuan: write off.levels.'),
  ('principal_policy.external_order_app_link', 'BUSINESS', 'SENSITIVE', 'COMMERCIAL_ADMIN', 'Konfigurasi Kebijakan Principal: external order app link.'),
  ('tax.direct_integration_enabled', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: direct integration enabled.'),
  ('tax.export_enabled', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: export enabled.'),
  ('tax.export_format_version', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: export format version.'),
  ('tax.input_vat_tolerance', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: input vat tolerance.'),
  ('tax.invoice_deadline_days', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: invoice deadline days.'),
  ('tax.rounding_rule', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: rounding rule.'),
  ('tax.vat_input_rate', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: vat input rate.'),
  ('tax.vat_output_rate', 'BUSINESS', 'SENSITIVE', 'CONTROLLER', 'Konfigurasi Pajak: vat output rate.'),
  ('finance.audit_adjustment_period_enabled', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: audit adjustment period enabled.'),
  ('finance.balance_tolerance', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: balance tolerance.'),
  ('finance.bank_api', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: bank api.'),
  ('finance.bank_line_rules', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: bank line rules.'),
  ('finance.branch_pnl_visible', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: branch pnl visible.'),
  ('finance.close.approver_role', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: close.approver role.'),
  ('finance.coa.code_pattern', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: coa.code pattern.'),
  ('finance.fiscal_year_autocreate_months', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: fiscal year autocreate months.'),
  ('finance.fiscal_year_start_month', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: fiscal year start month.'),
  ('finance.go_live_date', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: go live date.'),
  ('finance.journal.emergency_self_approval', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: journal.emergency self approval.'),
  ('finance.late_posting_default', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: late posting default.'),
  ('finance.petty_cash.max_per_expense', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: petty cash.max per expense.'),
  ('finance.post_discount_separately', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: post discount separately.'),
  ('finance.posting_enabled', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: posting enabled.'),
  ('finance.track_in_transit_account', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Keuangan: track in transit account.'),
  ('invoicing.consolidation_enabled', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Faktur: consolidation enabled.'),
  ('invoicing.grouping_rule', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Faktur: grouping rule.'),
  ('invoicing.recognition_point', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Faktur: recognition point.'),
  ('invoicing.top_start_basis', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Faktur: top start basis.'),
  ('payments.bank_auto_match_rules', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Pembayaran: bank auto match rules.'),
  ('payments.cash_in_hand_max_hours', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Pembayaran: cash in hand max hours.'),
  ('payments.giro_overdue_days', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Pembayaran: giro overdue days.'),
  ('payments.qris_va', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Pembayaran: qris va.'),
  ('payments.small_overpayment_threshold', 'BUSINESS', 'SENSITIVE', 'FINANCE_MAKER', 'Konfigurasi Pembayaran: small overpayment threshold.'),
  ('pos.credit_sale', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: credit sale.'),
  ('pos.enabled', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: enabled.'),
  ('pos.offline.max_sale_amount', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: offline.max sale amount.'),
  ('pos.price_list_scope', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: price list scope.'),
  ('pos.receipt.format', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: receipt.format.'),
  ('pos.shift.close_tolerance', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: shift.close tolerance.'),
  ('pos.shift.open_float_amount', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: shift.open float amount.'),
  ('pos.transfer.release_rule', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: transfer.release rule.'),
  ('pos.walk_in_customer_id', 'BUSINESS', 'SENSITIVE', 'POS_SUPERVISOR', 'Konfigurasi POS: walk in customer id.'),
  ('procurement.over_receipt_tolerance_pct', 'BUSINESS', 'SENSITIVE', 'PROCUREMENT_OFFICER', 'Konfigurasi Pengadaan: over receipt tolerance pct.'),
  ('procurement.po_approval_threshold', 'BUSINESS', 'SENSITIVE', 'PROCUREMENT_OFFICER', 'Konfigurasi Pengadaan: po approval threshold.'),
  ('procurement.price_match_tolerance', 'BUSINESS', 'SENSITIVE', 'PROCUREMENT_OFFICER', 'Konfigurasi Pengadaan: price match tolerance.'),
  ('orders.auto_confirm', 'BUSINESS', 'SENSITIVE', 'SALES_ADMIN', 'Konfigurasi Pesanan: auto confirm.'),
  ('identity.sod_exception', 'BUSINESS', 'SENSITIVE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: sod exception.'),
  ('inventory.cost_precision', 'BUSINESS', 'SENSITIVE', 'WAREHOUSE_ADMIN', 'Konfigurasi Persediaan: cost precision.'),
  ('inventory.costing_method', 'BUSINESS', 'SENSITIVE', 'WAREHOUSE_ADMIN', 'Konfigurasi Persediaan: costing method.'),
  ('inventory.transit_max_days', 'BUSINESS', 'SENSITIVE', 'WAREHOUSE_ADMIN', 'Konfigurasi Persediaan: transit max days.'),
  ('inventory.valuation_unit', 'BUSINESS', 'SENSITIVE', 'WAREHOUSE_ADMIN', 'Konfigurasi Persediaan: valuation unit.'),
  ('returns.approval_rule', 'BUSINESS', 'ROUTINE', 'AR_OFFICER', 'Konfigurasi Retur: approval rule.'),
  ('returns.supplier_return_enabled', 'BUSINESS', 'ROUTINE', 'AR_OFFICER', 'Konfigurasi Retur: supplier return enabled.'),
  ('commercial.claims_enabled', 'BUSINESS', 'ROUTINE', 'COMMERCIAL_ADMIN', 'Konfigurasi Komersial: claims enabled.'),
  ('commercial.promo_enabled', 'BUSINESS', 'ROUTINE', 'COMMERCIAL_ADMIN', 'Konfigurasi Komersial: promo enabled.'),
  ('fleet.capacity_block', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: capacity block.'),
  ('fleet.digital_signature', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: digital signature.'),
  ('fleet.driver_app_enabled', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: driver app enabled.'),
  ('fleet.driver_can_request_return', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: driver can request return.'),
  ('fleet.driver_silence_minutes', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: driver silence minutes.'),
  ('fleet.fail_photo_required', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: fail photo required.'),
  ('fleet.gps_interval_s', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: gps interval s.'),
  ('fleet.gps_retention_days', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: gps retention days.'),
  ('fleet.late_tolerance_minutes', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: late tolerance minutes.'),
  ('fleet.optimizer_timeout_s', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: optimizer timeout s.'),
  ('fleet.pod_missing_hours', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: pod missing hours.'),
  ('fleet.pod_policy', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: pod policy.'),
  ('fleet.route_economics', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: route economics.'),
  ('fleet.route_optimization', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: route optimization.'),
  ('fleet.vehicle_gps', 'BUSINESS', 'ROUTINE', 'FLEET_ADMIN', 'Konfigurasi Armada: vehicle gps.'),
  ('geo.nearby_max_radius_m', 'BUSINESS', 'ROUTINE', 'GIS_ADMIN', 'Konfigurasi Geo: nearby max radius m.'),
  ('geo.plus_code_length', 'BUSINESS', 'ROUTINE', 'GIS_ADMIN', 'Konfigurasi Geo: plus code length.'),
  ('geo.review_distance_m', 'BUSINESS', 'ROUTINE', 'GIS_ADMIN', 'Konfigurasi Geo: review distance m.'),
  ('geo.tile_source_url', 'BUSINESS', 'ROUTINE', 'GIS_ADMIN', 'Konfigurasi Geo: tile source url.'),
  ('geo.unmapped_outlet_days', 'BUSINESS', 'ROUTINE', 'GIS_ADMIN', 'Konfigurasi Geo: unmapped outlet days.'),
  ('master_data.duplicate_threshold', 'BUSINESS', 'ROUTINE', 'MASTER_DATA_STEWARD', 'Konfigurasi Data Induk: duplicate threshold.'),
  ('master_data.review_sla_days', 'BUSINESS', 'ROUTINE', 'MASTER_DATA_STEWARD', 'Konfigurasi Data Induk: review sla days.'),
  ('pos.offline_mode', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: offline mode.'),
  ('pos.offline.allow_immediate_handover', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: offline.allow immediate handover.'),
  ('pos.offline.max_hours', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: offline.max hours.'),
  ('pos.offline.number_block_size', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: offline.number block size.'),
  ('pos.pickup.sla_minutes', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: pickup.sla minutes.'),
  ('pos.qris_dynamic', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: qris dynamic.'),
  ('pos.qris.merchant_ref', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: qris.merchant ref.'),
  ('pos.qris.settlement_days', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: qris.settlement days.'),
  ('pos.reservation_expiry_minutes', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: reservation expiry minutes.'),
  ('pos.shift.max_hours', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: shift.max hours.'),
  ('pos.sod.cashier_not_handover', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: sod.cashier not handover.'),
  ('pos.transfer.max_wait_hours', 'BUSINESS', 'ROUTINE', 'POS_SUPERVISOR', 'Konfigurasi POS: transfer.max wait hours.'),
  ('orders.auto_confirm_external', 'BUSINESS', 'ROUTINE', 'SALES_ADMIN', 'Konfigurasi Pesanan: auto confirm external.'),
  ('orders.partial_confirmation', 'BUSINESS', 'ROUTINE', 'SALES_ADMIN', 'Konfigurasi Pesanan: partial confirmation.'),
  ('orders.shortage_wait_hours', 'BUSINESS', 'ROUTINE', 'SALES_ADMIN', 'Konfigurasi Pesanan: shortage wait hours.'),
  ('orders.whatsapp_intake_enabled', 'BUSINESS', 'ROUTINE', 'SALES_ADMIN', 'Konfigurasi Pesanan: whatsapp intake enabled.'),
  ('reporting.attribution', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi Pelaporan: attribution.'),
  ('sfa.app_enabled', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: app enabled.'),
  ('sfa.canvas_selling', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: canvas selling.'),
  ('sfa.geofence_block', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: geofence block.'),
  ('sfa.geofence_radius_m', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: geofence radius m.'),
  ('sfa.gps_accuracy_threshold_m', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: gps accuracy threshold m.'),
  ('sfa.order_without_visit', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: order without visit.'),
  ('sfa.photo_camera_only', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: photo camera only.'),
  ('sfa.show_credit_limit_amount', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: show credit limit amount.'),
  ('sfa.single_owner_per_outlet_stream', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: single owner per outlet stream.'),
  ('sfa.skip_photo_required', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi SFA: skip photo required.'),
  ('supervisor.app_enabled', 'BUSINESS', 'ROUTINE', 'SALES_SUPERVISOR', 'Konfigurasi Supervisor: app enabled.'),
  ('identity.access_token_minutes', 'BUSINESS', 'ROUTINE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: access token minutes.'),
  ('identity.max_devices_per_user', 'BUSINESS', 'ROUTINE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: max devices per user.'),
  ('identity.mfa_enforcement', 'BUSINESS', 'ROUTINE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: mfa enforcement.'),
  ('identity.refresh_token_hours', 'BUSINESS', 'ROUTINE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: refresh token hours.'),
  ('identity.shared_device_idle_minutes', 'BUSINESS', 'ROUTINE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: shared device idle minutes.'),
  ('identity.step_up_minutes', 'BUSINESS', 'ROUTINE', 'SYSTEM_ADMIN', 'Konfigurasi Identitas: step up minutes.'),
  ('fulfillment.admin_confirm_requires_evidence', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Fulfillment: admin confirm requires evidence.'),
  ('fulfillment.cross_branch_enabled', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Fulfillment: cross branch enabled.'),
  ('fulfillment.cutoff_time', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Fulfillment: cutoff time.'),
  ('fulfillment.delivery_date_backdate_days', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Fulfillment: delivery date backdate days.'),
  ('fulfillment.release_rule', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Fulfillment: release rule.'),
  ('fulfillment.sj_show_prices', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Fulfillment: sj show prices.'),
  ('inventory.reservation_expiry_hours', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Persediaan: reservation expiry hours.'),
  ('inventory.transfer_approval_rule', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Persediaan: transfer approval rule.'),
  ('wms.allow_lot_substitution', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: allow lot substitution.'),
  ('wms.count_freeze_location', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: count freeze location.'),
  ('wms.cycle_count_policy', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: cycle count policy.'),
  ('wms.min_remaining_shelf_life_days', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: min remaining shelf life days.'),
  ('wms.offline_task_buffer', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: offline task buffer.'),
  ('wms.paper_fallback_minutes', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: paper fallback minutes.'),
  ('wms.recount_threshold_pct', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: recount threshold pct.'),
  ('wms.task_stuck_minutes', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: task stuck minutes.'),
  ('wms.use_case_as_package', 'BUSINESS', 'ROUTINE', 'WAREHOUSE_ADMIN', 'Konfigurasi Gudang: use case as package.');
