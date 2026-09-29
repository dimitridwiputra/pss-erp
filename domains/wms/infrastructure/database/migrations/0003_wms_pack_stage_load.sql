-- WMS-007/008/009: a package (koli) moves through pack -> stage -> load. `staged_location_id`
-- and `loaded_vehicle_code` are opaque to any real fleet/shipment concept — WMS-008/009 track
-- "which lane is this koli in" and "what vehicle code was scanned for it", exactly the same
-- opaque-reference convention every other WMS task already uses; a real `fleet` domain, when it
-- exists, is free to build shipment-level grouping on top of this without WMS needing to know.
ALTER TABLE wms.warehouse_unit
  ADD COLUMN IF NOT EXISTS staged_location_id uuid REFERENCES wms.warehouse_location (id),
  ADD COLUMN IF NOT EXISTS loaded_vehicle_code text,
  ADD COLUMN IF NOT EXISTS loaded_at timestamptz;

ALTER TABLE wms.warehouse_task DROP CONSTRAINT warehouse_task_type_check;
ALTER TABLE wms.warehouse_task ADD CONSTRAINT warehouse_task_type_check
  CHECK (type IN ('RECEIVE', 'PUTAWAY', 'PICK', 'COUNT', 'PACK', 'STAGE', 'LOAD'));
