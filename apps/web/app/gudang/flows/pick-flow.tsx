'use client';

import type { NextWarehouseTaskResponse, WarehouseTaskOutcomeResponse } from '@pss/contracts';
import { Button, EmptyState, ErrorState, ExceptionSheet, LoadingState, MobileTaskTemplate, ScanScreen, TextField, Toast } from '@pss/ui';
import { enqueueOfflineConfirmation, openWmsOfflineDatabase } from '@pss/offline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useOnlineStatus } from '../hooks/use-online-status';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../lib/api-client';

const SHORT_REASONS = [
  { value: 'RC-WMS-SHORT_NOT_FOUND', label: 'Tidak ditemukan' },
  { value: 'RC-WMS-SHORT_DAMAGED', label: 'Rusak' },
  { value: 'RC-WMS-SHORT_EXPIRED', label: 'Kedaluwarsa' },
];

export function PickFlow({ warehouseId, switchModeAction }: { warehouseId: string; switchModeAction: ReactNode }) {
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const db = openWmsOfflineDatabase();
  const [locationCode, setLocationCode] = useState('');
  const [barcode, setBarcode] = useState('');
  const [qtyConfirmed, setQtyConfirmed] = useState('');
  const [shortReasonCode, setShortReasonCode] = useState<string>();
  const [scanErrorMessage, setScanErrorMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const nextTaskKey = ['gudang-next-task', warehouseId, 'PICK'];
  const nextTask = useQuery({
    queryKey: nextTaskKey,
    queryFn: () => gudangFetch<NextWarehouseTaskResponse>(`/gudang/tugas-berikutnya?warehouseId=${warehouseId}&type=PICK`),
    enabled: online,
    retry: false,
  });

  function resetInputs() {
    setLocationCode(''); setBarcode(''); setQtyConfirmed(''); setShortReasonCode(undefined); setScanErrorMessage(null);
  }

  const confirm = useMutation({
    mutationFn: (taskId: string) => gudangFetch<WarehouseTaskOutcomeResponse>(`/gudang/tugas/${taskId}/konfirmasi`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ scannedLocationCode: locationCode, scannedBarcode: barcode, qtyConfirmed, shortReasonCode }),
    }),
    onSuccess: (result) => {
      setFeedback(result.status === 'COMPLETED_SHORT' ? 'Selesai · barang kurang dilaporkan' : 'Selesai · lanjut ke tugas berikutnya');
      resetInputs();
      void queryClient.invalidateQueries({ queryKey: nextTaskKey });
    },
    onError: (error: unknown) => {
      if (error instanceof GudangApiError && error.problem.code === 'SCAN_MISMATCH') {
        setScanErrorMessage('Barang atau lokasi tidak sesuai tugas ini.');
      } else {
        setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal mengonfirmasi.');
      }
    },
  });

  if (!online) {
    // WMS-014: no server to fetch/validate a task from while offline, so there is no "next task"
    // screen offline — the operator works from whatever task they already saw and cached mentally
    // (or from a printed picking list past the paper-fallback threshold; see DOMAIN.md). This
    // form only queues a confirmation against a known taskId, using the task's own known
    // productId as the "scan" match (no offline barcode catalog exists to resolve a scanned
    // barcode locally — the location code is still checked, just not electronically re-verified
    // against a barcode). The server re-validates everything for real once `/gudang/sync` runs.
    return <OfflinePickConfirmForm db={db} switchModeAction={switchModeAction} />;
  }

  if (nextTask.isPending) return <LoadingState label="Memuat tugas pick" />;
  if (nextTask.isError) {
    const problem = nextTask.error instanceof GudangApiError ? nextTask.error.problem : null;
    return <ErrorState problem={problem} action={switchModeAction} />;
  }
  const task = nextTask.data?.task;
  if (!task) {
    return <EmptyState title="Tidak ada tugas pick" description="Semua tugas pick untuk gudang ini sudah selesai." action={switchModeAction} />;
  }

  const isShort = qtyConfirmed !== '' && Number(qtyConfirmed) < Number(task.qtyExpected);
  const canConfirm = Boolean(locationCode && barcode && qtyConfirmed && (!isShort || shortReasonCode));

  return (
    <MobileTaskTemplate
      context="Pick"
      instruction={`Ambil di ${task.locationCode}`}
      object={
        <ScanScreen
          title="Scan Lokasi" target={task.locationCode} instruction="Cocokkan dengan label lokasi"
          code={locationCode} onCodeChange={setLocationCode} onSubmitCode={() => {}}
          state={scanErrorMessage ? 'error' : 'default'} {...(scanErrorMessage ? { errorMessage: scanErrorMessage } : {})}
        />
      }
      details={
        <>
          <TextField id="scan-product" label="Scan barang (barcode)" value={barcode} onChange={(event) => setBarcode(event.target.value)} />
          <TextField id="qty-confirm" label={`Qty (target ${task.qtyExpected} ${task.uom})`} value={qtyConfirmed} onChange={(event) => setQtyConfirmed(event.target.value)} inputMode="decimal" />
          {isShort && (
            <ExceptionSheet
              title="Barang kurang" requested={`${task.qtyExpected} ${task.uom}`} available={`${qtyConfirmed} ${task.uom}`}
              reasons={SHORT_REASONS} selectedReason={shortReasonCode} onReasonChange={setShortReasonCode}
              onSubmit={() => confirm.mutate(task.id)} state={confirm.isPending ? 'loading' : 'default'}
            />
          )}
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone={feedback.includes('kurang') ? 'warning' : 'success'} /> : undefined}
      action={isShort ? undefined : <Button label="Konfirmasi" state={confirm.isPending ? 'loading' : 'default'} disabled={!canConfirm} onClick={() => confirm.mutate(task.id)} />}
    />
  );
}

function OfflinePickConfirmForm({ db, switchModeAction }: { db: ReturnType<typeof openWmsOfflineDatabase>; switchModeAction: ReactNode }) {
  const [taskId, setTaskId] = useState('');
  const [productId, setProductId] = useState('');
  const [locationCode, setLocationCode] = useState('');
  const [qtyConfirmed, setQtyConfirmed] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleQueue() {
    await enqueueOfflineConfirmation(db, taskId, {
      kind: 'PICK', scannedLocationCode: locationCode, scannedProductId: productId, qtyConfirmed,
    });
    setFeedback('Tersimpan · menunggu sinkronisasi');
    setTaskId(''); setProductId(''); setLocationCode(''); setQtyConfirmed('');
  }

  return (
    <MobileTaskTemplate
      context="Pick · Offline"
      instruction="Konfirmasi disimpan di perangkat, dikirim saat online"
      object={<TextField id="offline-pick-task" label="ID Tugas" value={taskId} onChange={(event) => setTaskId(event.target.value)} required />}
      details={
        <>
          <TextField id="offline-pick-location" label="Kode Lokasi" value={locationCode} onChange={(event) => setLocationCode(event.target.value)} required />
          <TextField id="offline-pick-product" label="ID Produk" value={productId} onChange={(event) => setProductId(event.target.value)} required />
          <TextField id="offline-pick-qty" label="Qty" value={qtyConfirmed} onChange={(event) => setQtyConfirmed(event.target.value)} inputMode="decimal" required />
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone="warning" /> : undefined}
      action={<Button label="Simpan (Offline)" disabled={!taskId || !locationCode || !productId || !qtyConfirmed} onClick={() => void handleQueue()} />}
    />
  );
}
