'use client';

import type { WarehouseReportResponse } from '@pss/contracts';
import { Button, DonutChart, ErrorState, HorizontalBarChart, KpiCard, Table, TrendLineChart } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, Gauge, PackageX, Timer, Users } from 'lucide-react';
import { useState } from 'react';
import { AdminShell } from '../nav-links';
import { GudangApiError, gudangFetch } from '../../lib/api-client';
import { RequireWarehouse } from '../require-warehouse';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function thirtyDaysAgoIso(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function downloadCsv(filename: string, rows: (string | number | null)[][]): void {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function ReportContent({ warehouseId }: { warehouseId: string }) {
  const [fromDate, setFromDate] = useState(thirtyDaysAgoIso());
  const [toDate, setToDate] = useState(todayIso());

  const query = useQuery({
    queryKey: ['gudang-admin-report', warehouseId, fromDate, toDate],
    queryFn: () => gudangFetch<WarehouseReportResponse>(`/wms/reports?warehouseId=${warehouseId}&from=${fromDate}&to=${toDate}`),
  });

  const trendByDate = (query.data?.throughputTrend ?? []).reduce<Record<string, number>>((acc, row) => {
    acc[row.date] = (acc[row.date] ?? 0) + row.count;
    return acc;
  }, {});
  const trendPoints = Object.entries(trendByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ label: date.slice(5), value }));

  return (
    <>
      <section className="pss-template-panel" aria-labelledby="pss-admin-report-filters">
        <div className="pss-template-filters">
          <h2 id="pss-admin-report-filters" style={{ marginRight: 'auto' }}>Periode</h2>
          <label>Dari <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label>Sampai <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        </div>
      </section>

      {query.isPending
        ? (
          <dl className="pss-kpi-grid">
            {Array.from({ length: 6 }, (_, i) => <KpiCard key={i} state="loading" icon={<Gauge />} label="Memuat…" value="" />)}
          </dl>
        )
        : query.isError
          ? <ErrorState problem={query.error instanceof GudangApiError ? query.error.problem : null} />
          : (
            <>
              <dl className="pss-kpi-grid">
                <KpiCard tone="info" icon={<Timer />} label="Rerata Waktu Terima" value={query.data.kpis.receivingTurnaroundAvgMinutes === null ? '—' : `${query.data.kpis.receivingTurnaroundAvgMinutes.toFixed(1)} mnt`} />
                <KpiCard tone="success" icon={<ClipboardCheck />} label="SLA Putaway" value={pct(query.data.kpis.putawaySlaPct)} />
                <KpiCard tone="success" icon={<CheckCircle2 />} label="Akurasi Pick" value={pct(query.data.kpis.pickAccuracyPct)} />
                <KpiCard tone="danger" icon={<PackageX />} label="Tingkat Short" value={pct(query.data.kpis.shortRatePct)} />
                <KpiCard tone="info" icon={<ClipboardCheck />} label="Akurasi Cycle Count" value={pct(query.data.kpis.cycleCountAccuracyPct)} />
                <KpiCard tone="warning" icon={<Users />} label="Tugas / Petugas Aktif" value={query.data.kpis.tasksPerActiveOperator?.toFixed(1) ?? '—'} />
              </dl>

              <div className="pss-template-columns">
                <section className="pss-template-panel" aria-labelledby="pss-admin-report-throughput">
                  <h2 id="pss-admin-report-throughput">Tren Throughput Tugas</h2>
                  {trendPoints.length === 0 ? <p>Tidak ada data pada periode ini.</p> : <TrendLineChart points={trendPoints} />}
                </section>
                <section className="pss-template-panel" aria-labelledby="pss-admin-report-composition">
                  <h2 id="pss-admin-report-composition">Komposisi Tugas per Jenis</h2>
                  {query.data.taskTypeComposition.length === 0 ? <p>Tidak ada data pada periode ini.</p>
                    : <DonutChart segments={query.data.taskTypeComposition.map((row) => ({ label: row.type, value: row.count }))} totalLabel="tugas" />}
                </section>
              </div>

              <section className="pss-template-panel" aria-labelledby="pss-admin-report-shorts">
                <h2 id="pss-admin-report-shorts">Distribusi Alasan Short</h2>
                {query.data.shortReasonDistribution.length === 0 ? <p>Tidak ada short pada periode ini.</p>
                  : <HorizontalBarChart bars={query.data.shortReasonDistribution.map((row) => ({ label: row.reasonCode, value: row.count }))} />}
              </section>

              <section className="pss-template-panel" aria-labelledby="pss-admin-report-detail">
                <div className="pss-template-filters">
                  <h2 id="pss-admin-report-detail" style={{ marginRight: 'auto' }}>Rincian Tugas</h2>
                  <Button
                    label="Unduh CSV" tone="secondary"
                    onClick={() => downloadCsv(
                      `laporan-gudang-${warehouseId}-${fromDate}-${toDate}.csv`,
                      [
                        ['Tugas', 'Tipe', 'Status', 'Lokasi', 'Produk', 'Qty diharapkan', 'Qty dikonfirmasi', 'Dibuat', 'Diperbarui'],
                        ...query.data.detailRows.map((row) => [row.taskId, row.type, row.status, row.locationCode, row.productId, row.qtyExpected, row.qtyConfirmed, row.createdAt, row.updatedAt]),
                      ],
                    )}
                  />
                </div>
                <Table
                  caption="Rincian tugas pada periode laporan"
                  columns={['Tugas', 'Tipe', 'Status', 'Lokasi', 'Qty diharapkan', 'Qty dikonfirmasi', 'Diperbarui']}
                  rows={query.data.detailRows.map((row) => [
                    row.taskId.slice(0, 8), row.type, row.status, row.locationCode ?? '—',
                    row.qtyExpected ?? '—', row.qtyConfirmed ?? '—', new Date(row.updatedAt).toLocaleString('id-ID'),
                  ])}
                  emptyMessage="Tidak ada tugas pada periode ini."
                />
              </section>
            </>
          )}
    </>
  );
}

export default function AdminReportPage() {
  return (
    <AdminShell title="Laporan Gudang" description="Pantau kinerja operasional gudang melalui berbagai laporan dan analitik.">
      <RequireWarehouse>{(warehouseId) => <ReportContent warehouseId={warehouseId} />}</RequireWarehouse>
    </AdminShell>
  );
}
