'use client';

import type { ActiveOperatorsResponse, ExceptionQueueResponse, WarehouseDashboardResponse } from '@pss/contracts';
import { Avatar, ErrorState, HorizontalBarChart, KpiCard, StatusPill, Table, TrendLineChart } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Boxes, ClipboardCheck, PackageX, Users } from 'lucide-react';
import Link from 'next/link';
import { GudangApiError, gudangFetch } from '../lib/api-client';
import { AdminShell } from './nav-links';
import { RequireWarehouse } from './require-warehouse';

const SEVERITY_TONE = { LOW: 'neutral', NORMAL: 'info', HIGH: 'danger' } as const;

function DashboardContent({ warehouseId }: { warehouseId: string }) {
  const query = useQuery({
    queryKey: ['gudang-admin-dashboard', warehouseId],
    queryFn: () => gudangFetch<WarehouseDashboardResponse>(`/wms/dashboard?warehouseId=${warehouseId}`),
    refetchInterval: 30_000,
  });
  const exceptionsQuery = useQuery({
    queryKey: ['gudang-admin-dashboard-exceptions', warehouseId],
    queryFn: () => gudangFetch<ExceptionQueueResponse>(`/wms/exceptions?warehouseId=${warehouseId}&status=OPEN`),
    refetchInterval: 30_000,
  });
  const operatorsQuery = useQuery({
    queryKey: ['gudang-admin-dashboard-operators', warehouseId],
    queryFn: () => gudangFetch<ActiveOperatorsResponse>(`/wms/operators/active?warehouseId=${warehouseId}`),
    refetchInterval: 30_000,
  });

  if (query.isPending) {
    return (
      <dl className="pss-kpi-grid">
        {Array.from({ length: 5 }, (_, i) => <KpiCard key={i} state="loading" icon={<Boxes />} label="Memuat…" value="" />)}
      </dl>
    );
  }
  if (query.isError) {
    const problem = query.error instanceof GudangApiError ? query.error.problem : null;
    return <ErrorState problem={problem} />;
  }

  const dashboard = query.data;
  const activeTaskCount = dashboard.taskCounts
    .filter((row) => ['CREATED', 'ASSIGNED', 'IN_PROGRESS'].includes(row.status))
    .reduce((sum, row) => sum + row.count, 0);
  const backlogByType = Object.entries(
    dashboard.taskCounts
      .filter((row) => !['COMPLETED', 'COMPLETED_SHORT', 'CANCELLED'].includes(row.status))
      .reduce<Record<string, number>>((acc, row) => { acc[row.type] = (acc[row.type] ?? 0) + row.count; return acc; }, {}),
  ).map(([label, value]) => ({ label, value }));
  const throughputPoints = dashboard.throughputPerHourToday.map((row) => ({ label: `${row.hour}:00`, value: row.count }));
  const openExceptions = exceptionsQuery.data?.items.slice(0, 5) ?? [];
  const operators = operatorsQuery.data?.operators ?? [];

  return (
    <>
      <dl className="pss-kpi-grid">
        <KpiCard tone="info" icon={<Boxes />} label="Tugas Aktif" value={activeTaskCount} />
        <KpiCard tone="danger" icon={<AlertTriangle />} label="Tugas Macet" value={dashboard.stuckTasks.length} />
        <KpiCard tone="warning" icon={<PackageX />} label="Short Hari Ini" value={dashboard.shortToday} />
        <KpiCard tone="info" icon={<ClipboardCheck />} label="Cycle Count Ditinjau" value={dashboard.cycleCountsPendingReview} />
        <KpiCard tone="success" icon={<Users />} label="Petugas Aktif" value={dashboard.activeOperatorCount} />
      </dl>

      <div className="pss-template-columns">
        <section className="pss-template-panel" aria-labelledby="pss-admin-dashboard-backlog">
          <h2 id="pss-admin-dashboard-backlog">Backlog per Jenis Tugas</h2>
          {backlogByType.length === 0 ? <p>Tidak ada tugas menunggu.</p> : <HorizontalBarChart bars={backlogByType} />}
        </section>
        <section className="pss-template-panel" aria-labelledby="pss-admin-dashboard-throughput">
          <h2 id="pss-admin-dashboard-throughput">Throughput Picking (hari ini)</h2>
          <TrendLineChart points={throughputPoints} />
        </section>
      </div>

      <div className="pss-template-columns">
        <section className="pss-template-panel" aria-labelledby="pss-admin-dashboard-exceptions">
          <h2 id="pss-admin-dashboard-exceptions">
            Hambatan Gudang{' '}
            <Link href="/gudang/admin/exceptions" className="pss-panel-link">Lihat semua</Link>
          </h2>
          {openExceptions.length === 0 ? <p>Tidak ada hambatan terbuka.</p> : (
            <ul className="pss-mini-list">
              {openExceptions.map((item) => (
                <li key={item.id}>
                  <StatusPill label={item.severity} tone={SEVERITY_TONE[item.severity]} />
                  <span className="pss-mini-list-title">{item.exceptionType}</span>
                  <span className="pss-mini-list-detail">{item.description ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="pss-template-panel" aria-labelledby="pss-admin-dashboard-operators">
          <h2 id="pss-admin-dashboard-operators">
            Petugas Aktif{' '}
            <Link href="/gudang/admin/petugas" className="pss-panel-link">Lihat semua</Link>
          </h2>
          {operators.length === 0 ? <p>Belum ada petugas tercatat.</p> : (
            <ul className="pss-mini-list pss-mini-list-people">
              {operators.slice(0, 6).map((operator) => (
                <li key={operator.userId}>
                  <Avatar name={operator.userId} size="sm" presence={operator.online ? 'online' : 'offline'} />
                  <span className="pss-mini-list-title">{operator.userId.slice(0, 8)}</span>
                  <StatusPill label={operator.online ? 'Online' : 'Offline'} tone={operator.online ? 'success' : 'neutral'} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dashboard.stuckTasks.length > 0 && (
        <section className="pss-template-panel" aria-labelledby="pss-admin-dashboard-stuck">
          <h2 id="pss-admin-dashboard-stuck">Tugas macet</h2>
          <Table
            caption="Tugas yang belum berubah status dalam waktu lama"
            columns={['Tugas', 'Tipe', 'Status', 'Menit sejak diperbarui', 'Petugas']}
            rows={dashboard.stuckTasks.map((task) => [task.taskId.slice(0, 8), task.type, task.status, task.minutesSinceUpdate, task.assigneeUserId?.slice(0, 8) ?? '—'])}
          />
        </section>
      )}

      <section className="pss-template-panel" aria-labelledby="pss-admin-dashboard-tasks">
        <h2 id="pss-admin-dashboard-tasks">Tugas per tipe &amp; status</h2>
        <Table
          caption="Jumlah tugas gudang menurut tipe dan status"
          columns={['Tipe', 'Status', 'Jumlah']}
          rows={dashboard.taskCounts.map((row) => [row.type, row.status, row.count])}
          emptyMessage="Belum ada tugas untuk gudang ini."
        />
      </section>
    </>
  );
}

export default function AdminDashboardPage() {
  return (
    <AdminShell title="Dashboard Gudang" description="Pantau dan kelola seluruh aktivitas operasional gudang secara real-time."
      actions={<StatusPill label="Data real-time" tone="success" />}>
      <RequireWarehouse>{(warehouseId) => <DashboardContent warehouseId={warehouseId} />}</RequireWarehouse>
    </AdminShell>
  );
}
