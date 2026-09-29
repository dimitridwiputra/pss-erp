'use client';

import type { ExceptionQueueResponse } from '@pss/contracts';
import { Button, ErrorState, KpiCard, LoadingState, StatusPill, TaskCard, TextField } from '@pss/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, MapPinOff, PackageMinus, PackageX, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../../lib/api-client';
import { AdminShell } from '../nav-links';
import { RequireWarehouse } from '../require-warehouse';

const TABS = [
  { value: 'OPEN', label: 'Terbuka' },
  { value: 'IN_PROGRESS', label: 'Ditangani' },
  { value: 'RESOLVED', label: 'Selesai' },
] as const;

const SEVERITY_TONE = { LOW: 'neutral', NORMAL: 'info', HIGH: 'danger' } as const;

const TYPE_KPIS = [
  { type: 'SCAN_MISMATCH', label: 'Scan Mismatch', icon: <ScanLine />, tone: 'warning' as const },
  { type: 'SHORT_ALLOCATION', label: 'Short Allocation', icon: <PackageMinus />, tone: 'danger' as const },
  { type: 'INVALID_LOCATION', label: 'Invalid Location', icon: <MapPinOff />, tone: 'warning' as const },
  { type: 'DAMAGED_GOODS', label: 'Damaged Goods', icon: <PackageX />, tone: 'danger' as const },
  { type: 'COUNT_VARIANCE', label: 'Count Variance', icon: <ListChecks />, tone: 'info' as const },
];

function ExceptionsContent({ warehouseId }: { warehouseId: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'OPEN' | 'IN_PROGRESS' | 'RESOLVED'>('OPEN');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assigneeInput, setAssigneeInput] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const allQuery = useQuery({
    queryKey: ['gudang-admin-exceptions-all', warehouseId],
    queryFn: () => gudangFetch<ExceptionQueueResponse>(`/wms/exceptions?warehouseId=${warehouseId}`),
    refetchInterval: 30_000,
  });
  const query = useQuery({
    queryKey: ['gudang-admin-exceptions', warehouseId, status],
    queryFn: () => gudangFetch<ExceptionQueueResponse>(`/wms/exceptions?warehouseId=${warehouseId}&status=${status}`),
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['gudang-admin-exceptions', warehouseId] });
    queryClient.invalidateQueries({ queryKey: ['gudang-admin-exceptions-all', warehouseId] });
  };

  const assign = useMutation({
    mutationFn: (id: string) => gudangFetch(`/wms/exceptions/${id}/assign`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(), body: JSON.stringify({ assignedTo: assigneeInput }),
    }),
    onSuccess: () => { setFeedback('Ditugaskan.'); invalidate(); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal menugaskan.'),
  });

  const resolve = useMutation({
    mutationFn: (id: string) => gudangFetch(`/wms/exceptions/${id}/resolve`, { method: 'POST', idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => { setFeedback('Ditandai selesai.'); setSelectedId(null); invalidate(); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal menyelesaikan.'),
  });

  const items = query.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const allItems = allQuery.data?.items ?? [];
  const countsByType = allItems.reduce<Record<string, number>>((acc, item) => { acc[item.exceptionType] = (acc[item.exceptionType] ?? 0) + 1; return acc; }, {});

  return (
    <>
      <dl className="pss-kpi-grid">
        {TYPE_KPIS.map((kpi) => (
          <KpiCard
            key={kpi.type} tone={kpi.tone} icon={kpi.icon} label={kpi.label}
            value={countsByType[kpi.type] ?? 0} state={allQuery.isPending ? 'loading' : 'default'}
          />
        ))}
      </dl>

      {feedback && <div className="pss-template-feedback" role="status">{feedback}</div>}
      <nav aria-label="Kategori antrian" className="pss-template-tabs">
        {TABS.map((tab) => (
          <Button key={tab.value} label={tab.label} tone={status === tab.value ? 'primary' : 'secondary'} onClick={() => { setStatus(tab.value); setSelectedId(null); }} />
        ))}
      </nav>
      <div className="pss-queue-content">
        <section aria-label="Daftar hambatan" className="pss-template-panel">
          {query.isPending ? <LoadingState label="Memuat antrian hambatan" />
            : query.isError ? <ErrorState problem={query.error instanceof GudangApiError ? query.error.problem : null} />
              : items.length === 0 ? <p>Tidak ada hambatan berstatus {status.toLowerCase()}.</p>
                : items.map((item) => (
                  <TaskCard
                    key={item.id}
                    title={`${item.exceptionType} · ${item.severity}`}
                    objectName={item.description ?? item.exceptionType}
                    details={`Dibuka ${new Date(item.openedAt).toLocaleString('id-ID')}${item.assignedTo ? ` · ditugaskan ke ${item.assignedTo.slice(0, 8)}` : ''}`}
                    actionLabel="Lihat rincian"
                    onAction={() => setSelectedId(item.id)}
                  />
                ))}
        </section>
        {selected && (
          <aside aria-label="Rincian hambatan" className="pss-template-panel">
            <StatusPill label={selected.severity} tone={SEVERITY_TONE[selected.severity]} />
            <h3>{selected.exceptionType}</h3>
            <p>{selected.description ?? 'Tidak ada deskripsi.'}</p>
            <dl>
              <div><dt>Referensi</dt><dd>{selected.referenceType ?? '—'} {selected.referenceId?.slice(0, 8) ?? ''}</dd></div>
              <div><dt>Dibuka</dt><dd>{new Date(selected.openedAt).toLocaleString('id-ID')}</dd></div>
              {selected.resolvedAt && <div><dt>Diselesaikan</dt><dd>{new Date(selected.resolvedAt).toLocaleString('id-ID')}</dd></div>}
            </dl>
            {selected.status !== 'RESOLVED' && (
              <>
                <TextField id="assignee-id" label="Tugaskan ke (ID petugas)" value={assigneeInput} onChange={(event) => setAssigneeInput(event.target.value)} />
                <Button label="Tugaskan" tone="secondary" state={assign.isPending ? 'loading' : 'default'} disabled={!assigneeInput} onClick={() => assign.mutate(selected.id)} />
                <Button label="Tandai selesai" state={resolve.isPending ? 'loading' : 'default'} onClick={() => resolve.mutate(selected.id)} />
              </>
            )}
          </aside>
        )}
      </div>
    </>
  );
}

export default function AdminExceptionsPage() {
  return (
    <AdminShell title="Hambatan & Exception Gudang" description="Kelola seluruh hambatan, pengecualian, dan anomali operasional gudang secara terpusat.">
      <RequireWarehouse>{(warehouseId) => <ExceptionsContent warehouseId={warehouseId} />}</RequireWarehouse>
    </AdminShell>
  );
}
