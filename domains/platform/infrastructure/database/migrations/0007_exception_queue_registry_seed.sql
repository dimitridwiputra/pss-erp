-- DQ-001.R01 seed: the initial queue registry is PRD Appendix P verbatim (P.1 seed registry
-- plus the P.2 additions from the feature specs). No code, label, role, action, or SLA value
-- is invented. Where Appendix P gives a duration it is stored as the default; where it names
-- a config key instead, the key is stored and the value is resolved at open time.
--
-- `dismissible` stays false everywhere because Appendix P does not state it for any queue
-- (DQ-001.AC06 therefore holds by default rather than by an invented permission).
-- `escalation_roles` is empty where Appendix P writes "—" or a level rather than a role.
-- `reason_codes` stays empty because Appendix P states a trigger condition, not a set of
-- reason codes; the enumeration is a per-queue decision for the queue owners.
-- `sla_value` is NULL for the queues whose registry SLA is "per tipe" or a KOSONG config key:
-- those are registered but not openable until their owner registers an SLA.

INSERT INTO platform.queue_definition
  (code, label, owner_roles, escalation_roles, sla_unit, sla_value, sla_config_key, permitted_actions)
VALUES
  ('Q-UNMAPPED_CUSTOMER', 'Toko belum dikenali', ARRAY['MASTER_DATA_STEWARD'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Petakan ke toko yang ada', 'Buat toko baru', 'Tolak']),
  ('Q-UNMAPPED_PRODUCT', 'Produk belum dikenali', ARRAY['MASTER_DATA_STEWARD'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Petakan', 'Buat', 'Tolak']),
  ('Q-UNMAPPED_SALESPERSON', 'Salesperson belum dikenali', ARRAY['MASTER_DATA_STEWARD'], ARRAY['BRANCH_MANAGER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Petakan', 'Tolak']),
  ('Q-POSSIBLE_DUPLICATE_ORDER', 'Kemungkinan pesanan ganda', ARRAY['SALES_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'HOURS', 4, NULL, ARRAY['Tandai berbeda', 'Tautkan sebagai duplikat']),
  ('Q-POSSIBLE_DUPLICATE_CUSTOMER', 'Kemungkinan toko ganda', ARRAY['MASTER_DATA_STEWARD'], '{}',
    'DAYS', 3, NULL, ARRAY['Tandai berbeda', 'Ajukan merge']),
  ('Q-IMPORT_REJECTED', 'Data impor tidak valid', ARRAY['INTEGRATION_OPERATOR'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Proses ulang setelah perbaikan', 'Tolak dengan alasan', 'Unduh']),
  ('Q-SYNC_FAILED', 'Sinkronisasi gagal', ARRAY['INTEGRATION_OPERATOR'], ARRAY['CFO', 'CEO / COO'],
    'HOURS', 2, NULL, ARRAY['Coba lagi', 'Unggah file manual']),
  ('Q-RECON_VARIANCE', 'Selisih rekonsiliasi', ARRAY['INTEGRATION_OPERATOR', 'FINANCE_MAKER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Ambil ulang periode', 'Terima dengan catatan']),
  ('Q-POST_CUTOVER_LEGACY', 'Data sistem lama setelah cutover', ARRAY['INTEGRATION_OPERATOR'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Selidiki', 'Tolak']),
  ('Q-EXTERNAL_AMENDMENT', 'Perubahan pesanan dari {sumber}', ARRAY['SALES_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'HOURS', 2, NULL, ARRAY['Terima perubahan (bila aman)', 'Tolak']),
  ('Q-CREDIT_HOLD', 'Pesanan perlu persetujuan kredit', ARRAY['BRANCH_MANAGER', 'FINANCE_APPROVER'], ARRAY['CFO'],
    'HOURS', 4, NULL, ARRAY['Setujui (limit level)', 'Tolak', 'Minta pembayaran']),
  ('Q-STOCK_SHORTAGE', 'Barang belum tersedia', ARRAY['SALES_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'HOURS', 4, NULL, ARRAY['Kirim sebagian + backorder', 'Tutup kurang', 'Batalkan baris']),
  ('Q-PICK_SHORT', 'Barang kurang saat disiapkan', ARRAY['SALES_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'HOURS', 2, NULL, ARRAY['Terima kurang', 'Siapkan ulang', 'Backorder']),
  ('Q-FAILED_DELIVERY', 'Gagal kirim', ARRAY['DISPATCHER', 'SALES_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'DAYS', 1, NULL, ARRAY['Jadwalkan ulang', 'Kembalikan ke stok', 'Batalkan']),
  ('Q-POD_MISSING', 'Bukti kirim belum ada', ARRAY['DISPATCHER', 'AR_OFFICER'], ARRAY['CONTROLLER'],
    'DAYS', 1, NULL, ARRAY['Unggah bukti', 'Eskalasi']),
  ('Q-DELIVERY_NOT_CONFIRMED', 'Pengiriman belum dikonfirmasi', ARRAY['SALES_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'DAYS', 1, NULL, ARRAY['Konfirmasi pengiriman']),
  ('Q-PAYMENT_MISMATCH', 'Pembayaran perlu dicek', ARRAY['AR_OFFICER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Cocokkan', 'Ubah alokasi', 'Pindah ke kredit customer', 'Tolak']),
  ('Q-UNAPPLIED_PAYMENT', 'Pembayaran belum dialokasikan', ARRAY['AR_OFFICER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 2, NULL, ARRAY['Alokasikan', 'Pindah ke kredit customer']),
  -- Appendix P ties this queue to payments.cash_in_hand_max_hours, whose Appendix N default is
  -- 24 hours. That registered default is stored here rather than guessed at open time.
  ('Q-CASH_HANDOVER_OVERDUE', 'Kas belum disetor', ARRAY['CASHIER', 'BRANCH_MANAGER'], ARRAY['CONTROLLER'],
    'HOURS', 24, NULL, ARRAY['Hubungi collector', 'Eskalasi']),
  ('Q-CASH_DISCREPANCY', 'Selisih kas', ARRAY['CASHIER', 'BRANCH_MANAGER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Selesaikan']),
  ('Q-OVERDUE_AR', 'Piutang terlambat > 60 hari', ARRAY['AR_OFFICER', 'SALES_SUPERVISOR'], ARRAY['CFO'],
    'DAYS', 3, NULL, ARRAY['Buat tugas tagih', 'Tahan kredit customer', 'Ajukan write-off']),
  ('Q-INVENTORY_VARIANCE', 'Selisih stok', ARRAY['WAREHOUSE_ADMIN', 'FINANCE_MAKER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 2, NULL, ARRAY['Hitung ulang', 'Ajukan penyesuaian']),
  ('Q-TRANSFER_DISCREPANCY', 'Selisih transfer', ARRAY['WAREHOUSE_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Ajukan penyesuaian', 'Selidiki']),
  ('Q-SUPPLIER_INVOICE_MATCH', 'Invoice supplier tidak cocok', ARRAY['PROCUREMENT_OFFICER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 2, NULL, ARRAY['Koreksi', 'Ajukan persetujuan selisih', 'Tolak']),
  ('Q-POSTING_FAILED', 'Jurnal otomatis gagal', ARRAY['CONTROLLER'], ARRAY['CFO'],
    'BUSINESS_DAYS', 1, NULL, ARRAY['Perbaiki mapping akun', 'coba lagi']),
  ('Q-POSTING_PERIOD_DECISION', 'Transaksi untuk periode terkunci', ARRAY['CONTROLLER'], ARRAY['CFO'],
    'BUSINESS_DAYS', 2, NULL, ARRAY['Posting di periode terbuka', 'Ajukan buka periode']),
  -- Appendix P gives "sebelum close", a milestone rather than a duration. No number is invented.
  ('Q-GL_SUBLEDGER_VARIANCE', 'Selisih buku besar vs subledger', ARRAY['CONTROLLER'], ARRAY['CFO'],
    'DAYS', NULL, NULL, ARRAY['Selidiki', 'Jurnal koreksi (non-control)', 'Tandai dijelaskan']),
  ('Q-BANK_UNMATCHED', 'Mutasi bank belum cocok', ARRAY['FINANCE_MAKER', 'CASHIER'], ARRAY['CONTROLLER'],
    'BUSINESS_DAYS', 2, NULL, ARRAY['Cocokkan', 'Buat jurnal (biaya bank)', 'Kecualikan']),
  -- Appendix P gives "per tipe": the SLA belongs to approval.<type>.expiry_hours, which the
  -- approval engine resolves. No number is invented here, so the queue stays closed.
  ('Q-APPROVAL_PENDING', 'Menunggu persetujuan Anda', ARRAY['CONTROLLER'], '{}',
    'HOURS', NULL, NULL, ARRAY['Setujui', 'Tolak']),
  ('Q-OUTLET_UNMAPPED_LOCATION', 'Toko belum ada lokasi', ARRAY['SALES_SUPERVISOR'], '{}',
    'DAYS', 14, NULL, ARRAY['Tugaskan rekam lokasi']),

  -- Appendix P.2 additions from the feature specs.
  ('Q-POLICY_MISSING', 'Aturan sistem belum ada', ARRAY['COMMERCIAL_ADMIN'], ARRAY['CFO', 'CEO / COO'],
    'HOURS', 4, NULL, ARRAY['Buat aturan', 'Tolak transaksi']),
  ('Q-STREAM_UNASSIGNED', 'Aliran pendapatan belum ditentukan', ARRAY['COMMERCIAL_ADMIN'], '{}',
    'BUSINESS_DAYS', 2, NULL, ARRAY['Tetapkan aturan']),
  ('Q-TAX_INVOICE_PENDING', 'Invoice perlu faktur pajak', ARRAY['FINANCE_MAKER'], '{}',
    'DAYS', NULL, 'tax.invoice_deadline_days', ARRAY['Ekspor', 'Catat nomor']),
  ('Q-INVOICE_BLOCKED', 'Invoice belum bisa terbit', ARRAY['SALES_ADMIN', 'FINANCE_MAKER'], '{}',
    'HOURS', 4, NULL, ARRAY['Lengkapi data pajak/produk']),
  ('Q-AP_LEDGER_REJECTED', 'Entri utang ditolak', ARRAY['CONTROLLER'], '{}',
    'BUSINESS_DAYS', 1, NULL, ARRAY['Selidiki', 'Proses ulang']),
  ('Q-LOCATION_REVIEW', 'Lokasi toko perlu dicek', ARRAY['MASTER_DATA_STEWARD'], '{}',
    'DAYS', 3, NULL, ARRAY['Verifikasi', 'Tolak']),
  ('Q-POS_PICKUP_PENDING', 'Lunas, belum diambil', ARRAY['WAREHOUSE_ADMIN'], ARRAY['BRANCH_MANAGER'],
    'MINUTES', NULL, 'pos.pickup.sla_minutes', ARRAY['Siapkan barang', 'Cari struk']),
  ('Q-POS_SHIFT_NOT_CLOSED', 'Shift belum ditutup', ARRAY['POS_SUPERVISOR'], ARRAY['BRANCH_MANAGER'],
    'HOURS', NULL, 'pos.shift.max_hours', ARRAY['Tutup shift', 'Force close']),
  ('Q-POS_TRANSFER_PENDING', 'Menunggu dana masuk', ARRAY['POS_CASHIER', 'POS_SUPERVISOR'], '{}',
    'HOURS', NULL, 'pos.transfer.max_wait_hours', ARRAY['Cocokkan mutasi', 'Setujui rilis dengan bukti']),
  ('Q-POS_QRIS_UNSETTLED', 'QRIS belum settle', ARRAY['FINANCE_MAKER'], '{}',
    'DAYS', NULL, 'pos.qris.settlement_days', ARRAY['Cocokkan settlement']),
  ('Q-POS_OFFLINE_CONFLICT', 'Transaksi offline perlu diperiksa', ARRAY['POS_SUPERVISOR'], '{}',
    'HOURS', 4, NULL, ARRAY['Selesaikan konflik stok/harga'])
ON CONFLICT (code) DO NOTHING;
