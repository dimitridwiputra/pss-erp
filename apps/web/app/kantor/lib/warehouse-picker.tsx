'use client';

import { useKantorSession } from '../warehouse-context';

/**
 * The warehouse picker, for a screen whose subject is one warehouse's stock.
 *
 * It lives on the screen rather than in the frame because the frame is shared with the screens that
 * have no warehouse: a master record, a price list, a customer. Putting the picker in the frame would
 * offer a choice to screens where it means nothing.
 *
 * **The list is the caller's own WAREHOUSE-scoped grants**, never configuration (MVP-OD-22: no
 * domain can resolve a warehouse id to an owner, so the honest source is who the caller is allowed to
 * act for). One warehouse in scope needs no control at all, and saying so is clearer than a
 * disabled one.
 */
export function WarehousePicker() {
  const { warehouseId, warehouseIds, setWarehouseId, pending } = useKantorSession();

  if (pending) return <span className="pss-muted">Memuat gudang…</span>;
  if (warehouseIds.length === 0) return <span className="pss-muted">Tidak ada cakupan gudang</span>;
  if (warehouseIds.length === 1) return <span className="pss-muted">Gudang {shortId(warehouseId)}</span>;

  return (
    <label className="pss-form-field" style={{ margin: 0, minWidth: 180 }}>
      <span className="pss-visually-hidden">Gudang</span>
      <select value={warehouseId ?? ''} onChange={(event) => setWarehouseId(event.target.value)}>
        {warehouseIds.map((id) => <option key={id} value={id}>{shortId(id)}</option>)}
      </select>
    </label>
  );
}

function shortId(warehouseId: string | null): string {
  return warehouseId ? `${warehouseId.slice(0, 8)}…` : '—';
}
