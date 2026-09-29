'use client';

import type { WarehouseDashboardResponse } from '@pss/contracts';
import { ErrorState, LoadingState, StatusPill, Table } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { GudangApiError, gudangFetch } from '../lib/api-client';

/**
 * WMS-015 (simplified): reads `GET /wms/dashboard`, a live aggregation over this domain's own
 * tables rather than a projected `reporting` read model — see `domains/wms`'s DOMAIN.md for why
 * (WMS-015.NC01 is deliberately out of spec here). `asOf` is always "now" as a result.
 */
export function DashboardFlow({ warehouseId, switchModeAction }: { warehouseId: string; switchModeAction: ReactNode }) {
  const query = useQuery({
    queryKey: ['gudang-dashboard', warehouseId],
    queryFn: () => gudangFetch<WarehouseDashboardResponse>(`/wms/dashboard?warehouseId=${warehouseId}`),
    refetchInterval: 60_000,
  });

  if (query.isPending) return <LoadingState label="Memuat dashboard gudang" />;
  if (query.isError) {
    const problem = query.error instanceof GudangApiError ? query.error.problem : null;
    return <ErrorState problem={problem} action={switchModeAction} />;
  }

  const dashboard = query.data;
  const shortRow = dashboard.taskCounts.find((row) => row.status === 'COMPLETED_SHORT');

  return (
    <main className="pss-page-template">
      <header className="pss-template-header">
        <p className="pss-template-eyebrow">PSS Gudang</p>
        <h1>Dashboard Gudang</h1>
        <StatusPill label={`Diperbarui ${new Date(dashboard.asOf).toLocaleTimeString('id-ID')}`} tone="info" />
      </header>

      <section className="pss-template-panel" aria-labelledby="pss-dashboard-kpis">
        <h2 id="pss-dashboard-kpis">Ringkasan</h2>
        <dl>
          <div><dt>Short hari ini</dt><dd>{dashboard.shortToday}</dd></div>
          <div><dt>Selisih menunggu tinjauan</dt><dd>{dashboard.discrepanciesPendingReview}</dd></div>
          <div><dt>Hitung stok menunggu tinjauan</dt><dd>{dashboard.cycleCountsPendingReview}</dd></div>
        </dl>
        {shortRow && shortRow.count > 0 && <p role="status">Ada {shortRow.count} tugas berstatus kurang (short) tercatat.</p>}
      </section>

      <section className="pss-template-panel" aria-labelledby="pss-dashboard-tasks">
        <h2 id="pss-dashboard-tasks">Tugas per tipe &amp; status</h2>
        <Table
          caption="Jumlah tugas gudang menurut tipe dan status"
          columns={['Tipe', 'Status', 'Jumlah']}
          rows={dashboard.taskCounts.map((row) => [row.type, row.status, row.count])}
          emptyMessage="Belum ada tugas untuk gudang ini."
        />
      </section>

      <footer className="pss-mobile-action">{switchModeAction}</footer>
    </main>
  );
}
