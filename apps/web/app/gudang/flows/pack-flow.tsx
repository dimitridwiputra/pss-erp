'use client';

import type { CompletePackingResponse, WarehouseUnitResponse } from '@pss/contracts';
import { Button, MobileTaskTemplate, TextField, Toast } from '@pss/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../lib/api-client';

/** WMS-007: "Buat Koli" -> repeat "scan barang ke koli" -> "Selesai Pack". */
export function PackFlow({ warehouseId, switchModeAction }: { warehouseId: string; switchModeAction: ReactNode }) {
  const [referenceId, setReferenceId] = useState('');
  const [unit, setUnit] = useState<WarehouseUnitResponse | null>(null);
  const [productId, setProductId] = useState('');
  const [uom, setUom] = useState('KARTON');
  const [qty, setQty] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const createUnit = useMutation({
    mutationFn: () => gudangFetch<WarehouseUnitResponse>('/wms/units', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ warehouseId, unitType: 'CARTON', referenceType: 'FULFILLMENT_REQUEST', referenceId }),
    }),
    onSuccess: (result) => { setUnit(result); setFeedback(`Koli ${result.code} dibuat`); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal membuat koli.'),
  });

  const scanIntoUnit = useMutation({
    mutationFn: () => gudangFetch(`/gudang/koli/${unit!.code}/scan`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ productId, uom, qty }),
    }),
    onSuccess: () => { setFeedback(`Ditambahkan ke koli ${unit!.code}`); setProductId(''); setQty(''); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal memindai barang.'),
  });

  const completePacking = useMutation({
    mutationFn: () => gudangFetch<CompletePackingResponse>('/gudang/koli/selesai', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ warehouseId, referenceType: 'FULFILLMENT_REQUEST', referenceId }),
    }),
    onSuccess: (result) => { setFeedback(`Selesai pack · ${result.packageCount} koli`); setUnit(null); setReferenceId(''); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal menyelesaikan pack.'),
  });

  return (
    <MobileTaskTemplate
      context="Pack"
      instruction={unit ? `Koli aktif: ${unit.code}` : 'Scan FR / DO untuk mulai pack'}
      object={<TextField id="pack-reference" label="ID Referensi (FR/DO)" value={referenceId} onChange={(event) => setReferenceId(event.target.value)} disabled={Boolean(unit)} required />}
      details={
        <>
          {!unit && <Button label="Buat Koli" state={createUnit.isPending ? 'loading' : 'default'} disabled={!referenceId} onClick={() => createUnit.mutate()} />}
          {unit && (
            <>
              <TextField id="pack-product" label="ID Produk" value={productId} onChange={(event) => setProductId(event.target.value)} required />
              <TextField id="pack-uom" label="Satuan" value={uom} onChange={(event) => setUom(event.target.value)} required />
              <TextField id="pack-qty" label="Qty" value={qty} onChange={(event) => setQty(event.target.value)} inputMode="decimal" required />
              <Button label="Scan ke Koli" state={scanIntoUnit.isPending ? 'loading' : 'default'} disabled={!productId || !uom || !qty} onClick={() => scanIntoUnit.mutate()} />
            </>
          )}
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone={completePacking.isError || scanIntoUnit.isError || createUnit.isError ? 'danger' : 'success'} /> : undefined}
      action={unit ? <Button label="Selesai Pack" tone="secondary" state={completePacking.isPending ? 'loading' : 'default'} onClick={() => completePacking.mutate()} /> : undefined}
    />
  );
}
