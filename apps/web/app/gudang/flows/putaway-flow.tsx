'use client';

import type { NextWarehouseTaskResponse, WarehouseTaskOutcomeResponse } from '@pss/contracts';
import { Button, EmptyState, ErrorState, LoadingState, MobileTaskTemplate, ScanScreen, TextField, Toast } from '@pss/ui';
import { enqueueOfflineConfirmation, openWmsOfflineDatabase } from '@pss/offline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useOnlineStatus } from '../hooks/use-online-status';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../lib/api-client';

export function PutawayFlow({ warehouseId, switchModeAction }: { warehouseId: string; switchModeAction: ReactNode }) {
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const db = openWmsOfflineDatabase();
  const [toLocationCode, setToLocationCode] = useState('');
  const [qtyConfirmed, setQtyConfirmed] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const nextTaskKey = ['gudang-next-task', warehouseId, 'PUTAWAY'];
  const nextTask = useQuery({
    queryKey: nextTaskKey,
    queryFn: () => gudangFetch<NextWarehouseTaskResponse>(`/gudang/tugas-berikutnya?warehouseId=${warehouseId}&type=PUTAWAY`),
    enabled: online,
    retry: false,
  });

  const confirm = useMutation({
    mutationFn: (taskId: string) => gudangFetch<WarehouseTaskOutcomeResponse>(`/gudang/putaway/${taskId}/konfirmasi`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ toLocationCode, qtyConfirmed }),
    }),
    onSuccess: (result) => {
      setFeedback(result.status === 'COMPLETED_SHORT' ? 'Tersimpan sebagian · lanjut ke tugas berikutnya' : 'Tersimpan · lanjut ke tugas berikutnya');
      setToLocationCode(''); setQtyConfirmed(''); setErrorMessage(null);
      void queryClient.invalidateQueries({ queryKey: nextTaskKey });
    },
    onError: (error: unknown) => {
      if (error instanceof GudangApiError && error.problem.code === 'NOT_FOUND') setErrorMessage('Lokasi tidak dikenal.');
      else setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal mengonfirmasi.');
    },
  });

  if (!online) {
    return <OfflinePutawayConfirmForm db={db} switchModeAction={switchModeAction} />;
  }

  if (nextTask.isPending) return <LoadingState label="Memuat tugas putaway" />;
  if (nextTask.isError) {
    const problem = nextTask.error instanceof GudangApiError ? nextTask.error.problem : null;
    return <ErrorState problem={problem} action={switchModeAction} />;
  }
  const task = nextTask.data?.task;
  if (!task) {
    return <EmptyState title="Tidak ada tugas putaway" description="Semua tugas putaway sudah selesai." action={switchModeAction} />;
  }

  return (
    <MobileTaskTemplate
      context="Putaway"
      instruction={`Simpan ${task.qtyExpected} ${task.uom} dari ${task.locationCode}`}
      object={
        <ScanScreen
          title="Scan Lokasi Tujuan" target="Pindai lokasi bin tujuan" instruction="Cocokkan dengan label lokasi"
          code={toLocationCode} onCodeChange={setToLocationCode} onSubmitCode={() => {}}
          state={errorMessage ? 'error' : 'default'} {...(errorMessage ? { errorMessage } : {})}
        />
      }
      details={
        <>
          <TextField id="putaway-qty" label={`Qty (target ${task.qtyExpected} ${task.uom})`} value={qtyConfirmed} onChange={(event) => setQtyConfirmed(event.target.value)} inputMode="decimal" />
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone="success" /> : undefined}
      action={<Button label="Konfirmasi" state={confirm.isPending ? 'loading' : 'default'} disabled={!toLocationCode || !qtyConfirmed} onClick={() => confirm.mutate(task.id)} />}
    />
  );
}

/** WMS-014: no server to fetch a task from while offline — queues against a known taskId, exactly like the online form's fields. */
function OfflinePutawayConfirmForm({ db, switchModeAction }: { db: ReturnType<typeof openWmsOfflineDatabase>; switchModeAction: ReactNode }) {
  const [taskId, setTaskId] = useState('');
  const [toLocationCode, setToLocationCode] = useState('');
  const [qtyConfirmed, setQtyConfirmed] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleQueue() {
    await enqueueOfflineConfirmation(db, taskId, { kind: 'PUTAWAY', toLocationCode, qtyConfirmed });
    setFeedback('Tersimpan · menunggu sinkronisasi');
    setTaskId(''); setToLocationCode(''); setQtyConfirmed('');
  }

  return (
    <MobileTaskTemplate
      context="Putaway · Offline"
      instruction="Konfirmasi disimpan di perangkat, dikirim saat online"
      object={<TextField id="offline-putaway-task" label="ID Tugas" value={taskId} onChange={(event) => setTaskId(event.target.value)} required />}
      details={
        <>
          <TextField id="offline-putaway-location" label="Kode Lokasi Tujuan" value={toLocationCode} onChange={(event) => setToLocationCode(event.target.value)} required />
          <TextField id="offline-putaway-qty" label="Qty" value={qtyConfirmed} onChange={(event) => setQtyConfirmed(event.target.value)} inputMode="decimal" required />
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone="warning" /> : undefined}
      action={<Button label="Simpan (Offline)" disabled={!taskId || !toLocationCode || !qtyConfirmed} onClick={() => void handleQueue()} />}
    />
  );
}
