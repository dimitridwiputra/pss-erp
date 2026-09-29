'use client';

import type { ActiveOperatorsResponse } from '@pss/contracts';
import { Avatar, ErrorState, KpiCard, StatusPill, Table } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { UserCheck, Users, WifiOff } from 'lucide-react';
import { GudangApiError, gudangFetch } from '../../lib/api-client';
import { AdminShell } from '../nav-links';
import { RequireWarehouse } from '../require-warehouse';

function WorkforceContent({ warehouseId }: { warehouseId: string }) {
  const query = useQuery({
    queryKey: ['gudang-admin-operators', warehouseId],
    queryFn: () => gudangFetch<ActiveOperatorsResponse>(`/wms/operators/active?warehouseId=${warehouseId}`),
    refetchInterval: 15_000,
  });

  if (query.isPending) {
    return (
      <dl className="pss-kpi-grid">
        {Array.from({ length: 3 }, (_, i) => <KpiCard key={i} state="loading" icon={<Users />} label="Memuat…" value="" />)}
      </dl>
    );
  }
  if (query.isError) return <ErrorState problem={query.error instanceof GudangApiError ? query.error.problem : null} />;

  const operators = query.data.operators;
  const onlineCount = operators.filter((op) => op.online).length;
  const offlineCount = operators.length - onlineCount;

  return (
    <>
      <dl className="pss-kpi-grid">
        <KpiCard tone="success" icon={<UserCheck />} label="Sedang Online" value={onlineCount} />
        <KpiCard tone="neutral" icon={<WifiOff />} label="Sedang Offline" value={offlineCount} />
        <KpiCard tone="info" icon={<Users />} label="Total Tercatat (24 jam)" value={operators.length} />
      </dl>

      <section className="pss-template-panel" aria-labelledby="pss-admin-workforce-list">
        <h2 id="pss-admin-workforce-list">Daftar Petugas</h2>
        <Table
          caption="Status petugas gudang berdasarkan heartbeat sesi"
          columns={['Petugas', 'Status', 'Tugas berjalan', 'Terakhir terlihat']}
          rows={operators.map((op) => [
            <span key="name" className="pss-table-person"><Avatar name={op.userId} size="sm" presence={op.online ? 'online' : 'offline'} />{op.userId.slice(0, 8)}</span>,
            <StatusPill key="status" label={op.online ? 'Online' : 'Offline'} tone={op.online ? 'success' : 'neutral'} />,
            op.currentTaskType ?? '—',
            new Date(op.lastSeenAt).toLocaleString('id-ID'),
          ])}
          emptyMessage="Belum ada petugas yang tercatat untuk gudang ini."
        />
      </section>
    </>
  );
}

export default function AdminWorkforcePage() {
  return (
    <AdminShell title="Petugas Aktif & Workforce Monitor" description="Pantau aktivitas dan status kehadiran petugas gudang secara real-time.">
      <RequireWarehouse>{(warehouseId) => <WorkforceContent warehouseId={warehouseId} />}</RequireWarehouse>
    </AdminShell>
  );
}
