-- WMS-014.R02: a manual result entered after a paper fallback, or a confirmation queued while a
-- handheld device was offline, must be auditable as such (not silently recorded as WEB/MOBILE/API).
ALTER TABLE audit.audit_entry DROP CONSTRAINT audit_entry_source_check;
ALTER TABLE audit.audit_entry ADD CONSTRAINT audit_entry_source_check
  CHECK (source IN ('WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT', 'OFFLINE', 'PAPER'));
