'use client';

import type { LocationUtilizationResponse } from '@pss/contracts';
import { ErrorState, KpiCard, StatusPill, Table } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, Boxes, Gauge, MapPinCheck } from 'lucide-react';
import { useState } from 'react';
import { AdminShell } from '../nav-links';
import { GudangApiError, gudangFetch } from '../../lib/api-client';
import { RequireWarehouse } from '../require-warehouse';

function LocationsContent({ warehouseId }: { warehouseId: string }) {
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: ['gudang-admin-locations', warehouseId],
    queryFn: () => gudangFetch<LocationUtilizationResponse>(`/wms/locations/utilization?warehouseId=${warehouseId}`),
    refetchInterval: 30_000,
  });

  if (query.isPending) {
    return (
      <dl className="pss-kpi-grid">
        {Array.from({ length: 4 }, (_, i) => <KpiCard key={i} state="loading" icon={<Boxes />} label="Memuat…" value="" />)}
      </dl>
    );
  }
  if (query.isError) return <ErrorState problem={query.error instanceof GudangApiError ? query.error.problem : null} />;

  const locations = query.data.locations;
  const activeCount = locations.filter((l) => l.status === 'ACTIVE').length;
  const blockedCount = locations.filter((l) => l.status === 'BLOCKED').length;
  const rated = locations.filter((l) => l.utilizationPct !== null);
  const avgUtilization = rated.length > 0 ? (rated.reduce((sum, l) => sum + (l.utilizationPct ?? 0), 0) / rated.length) * 100 : null;
  const nearFullCount = rated.filter((l) => (l.utilizationPct ?? 0) >= 0.9).length;
  const visible = status ? locations.filter((l) => l.status === status) : locations;

  return (
    <>
      <dl className="pss-kpi-grid">
        <KpiCard tone="info" icon={<Boxes />} label="Total Lokasi" value={locations.length} />
        <KpiCard tone="success" icon={<MapPinCheck />} label="Lokasi Aktif" value={activeCount} />
        <KpiCard tone="warning" icon={<Gauge />} label="Rata-rata Utilisasi" value={avgUtilization === null ? '—' : `${avgUtilization.toFixed(0)}%`} />
        <KpiCard tone="danger" icon={<AlertOctagon />} label="Hampir Penuh (≥90%)" value={nearFullCount} />
      </dl>

      <section className="pss-template-panel" aria-labelledby="pss-admin-locations">
        <div className="pss-template-filters">
          <h2 id="pss-admin-locations" style={{ marginRight: 'auto' }}>Daftar Lokasi</h2>
          <label>
            Status{' '}
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Semua ({locations.length})</option>
              <option value="ACTIVE">Aktif ({activeCount})</option>
              <option value="BLOCKED">Diblokir ({blockedCount})</option>
            </select>
          </label>
        </div>
        <Table
          caption="Kapasitas dan pemanfaatan tiap lokasi gudang"
          columns={['Lokasi', 'Tipe', 'Status', 'Qty di tangan', 'Kapasitas', 'Pemanfaatan']}
          rows={visible.map((location) => [
            location.code, location.type,
            <StatusPill key="status" label={location.status === 'ACTIVE' ? 'Aktif' : 'Diblokir'} tone={location.status === 'ACTIVE' ? 'success' : 'danger'} />,
            location.qtyOnHand, location.capacityQty ?? '—',
            location.utilizationPct === null
              ? <span key="util" style={{ color: 'var(--gray-500)' }}>Kapasitas belum dicatat</span>
              : (() => {
                const pct = location.utilizationPct * 100;
                return (
                  <div className="pss-utilization-bar" key="bar" title={`${pct.toFixed(0)}%`}>
                    <span
                      className={`pss-utilization-fill${pct >= 90 ? ' pss-utilization-fill-high' : ''}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                );
              })(),
          ])}
          emptyMessage="Belum ada lokasi terdaftar untuk gudang ini."
        />
      </section>
    </>
  );
}

export default function AdminLocationsPage() {
  return (
    <AdminShell title="Stok Lokasi / Inventory Bin" description="Lihat posisi stok per lokasi secara real-time di seluruh area gudang.">
      <RequireWarehouse>{(warehouseId) => <LocationsContent warehouseId={warehouseId} />}</RequireWarehouse>
    </AdminShell>
  );
}
