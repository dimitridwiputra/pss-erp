'use client';

import type { ListWarehouseTasksResponse } from '@pss/contracts';
import { ErrorState, LoadingState, StatusPill, Table } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { GudangApiError, gudangFetch } from '../../lib/api-client';
import { AdminShell } from '../nav-links';
import { RequireWarehouse } from '../require-warehouse';

const TASK_TYPES = ['RECEIVE', 'PUTAWAY', 'PICK', 'COUNT', 'PACK', 'STAGE', 'LOAD'] as const;
const TASK_STATUSES = ['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_SHORT', 'CANCELLED'] as const;
const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  CREATED: 'neutral', ASSIGNED: 'info', IN_PROGRESS: 'info',
  COMPLETED: 'success', COMPLETED_SHORT: 'warning', CANCELLED: 'danger',
};

function TaskQueueContent({ warehouseId }: { warehouseId: string }) {
  const searchParams = useSearchParams();
  const quickSearch = searchParams.get('q')?.trim().toLowerCase() ?? '';
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');

  const query = useQuery({
    queryKey: ['gudang-admin-tasks', warehouseId, status],
    queryFn: () => {
      const params = new URLSearchParams({ warehouseId, limit: '500' });
      if (status) params.set('status', status);
      return gudangFetch<ListWarehouseTasksResponse>(`/wms/tasks?${params.toString()}`);
    },
    refetchInterval: 15_000,
  });

  const allTasks = query.data?.tasks ?? [];
  const countsByType = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of allTasks) counts[task.type] = (counts[task.type] ?? 0) + 1;
    return counts;
  }, [allTasks]);

  const visibleTasks = allTasks.filter((task) => {
    if (type && task.type !== type) return false;
    if (!quickSearch) return true;
    return [task.taskId, task.locationCode, task.productId].some((field) => field?.toLowerCase().includes(quickSearch));
  });

  return (
    <>
      <nav className="pss-template-tabs" aria-label="Filter tipe tugas">
        <button type="button" className={`pss-tab${type === '' ? ' pss-tab-active' : ''}`} onClick={() => setType('')}>Semua ({allTasks.length})</button>
        {TASK_TYPES.map((option) => (
          <button key={option} type="button" className={`pss-tab${type === option ? ' pss-tab-active' : ''}`} onClick={() => setType(option)}>
            {option} ({countsByType[option] ?? 0})
          </button>
        ))}
      </nav>

      <section className="pss-template-panel" aria-labelledby="pss-admin-tasks">
        <div className="pss-template-filters">
          <h2 id="pss-admin-tasks" style={{ marginRight: 'auto' }}>Daftar Tugas</h2>
          {quickSearch && <StatusPill label={`Pencarian: "${quickSearch}"`} tone="info" />}
          <label>
            Status{' '}
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Semua</option>
              {TASK_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>

        {query.isPending
          ? <LoadingState label="Memuat antrian tugas" />
          : query.isError
            ? <ErrorState problem={query.error instanceof GudangApiError ? query.error.problem : null} />
            : (
              <Table
                caption="Antrian tugas operasional gudang"
                columns={['Tugas', 'Tipe', 'Status', 'Lokasi', 'Qty diharapkan', 'Qty dikonfirmasi', 'Petugas', 'Diperbarui']}
                rows={visibleTasks.map((task) => [
                  task.taskId.slice(0, 8), task.type,
                  <StatusPill key="status" label={task.status} tone={STATUS_TONE[task.status] ?? 'neutral'} />,
                  task.locationCode ?? '—', task.qtyExpected ?? '—', task.qtyConfirmed ?? '—',
                  task.assigneeUserId?.slice(0, 8) ?? '—', new Date(task.updatedAt).toLocaleString('id-ID'),
                ])}
                emptyMessage="Tidak ada tugas yang cocok dengan filter."
              />
            )}
      </section>
    </>
  );
}

export default function AdminTasksPage() {
  return (
    <AdminShell title="Antrian Tugas Operasional" description="Kelola dan pantau seluruh tugas operasional gudang secara real-time.">
      <Suspense fallback={<LoadingState label="Memuat antrian tugas" />}>
        <RequireWarehouse>{(warehouseId) => <TaskQueueContent warehouseId={warehouseId} />}</RequireWarehouse>
      </Suspense>
    </AdminShell>
  );
}
