-- WMS-014.R02: a manual result entered after a paper fallback, or a confirmation queued while a
-- handheld device was offline, must be auditable as such (not silently recorded as WEB/MOBILE/API).
--
-- Replayable. On a fresh database this widens the heap's source check exactly as it always did.
-- Once 0006 has swapped in the partitioned table, whose own check (0003) already allows OFFLINE and
-- PAPER, the heap and its constraint no longer exist and this is a no-op; it used to fail there, so a
-- second `pnpm dev:up` aborted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_entry_source_check' AND conrelid = 'audit.audit_entry'::regclass) THEN
    ALTER TABLE audit.audit_entry DROP CONSTRAINT audit_entry_source_check;
    ALTER TABLE audit.audit_entry ADD CONSTRAINT audit_entry_source_check
      CHECK (source IN ('WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT', 'OFFLINE', 'PAPER'));
  END IF;
END $$;
