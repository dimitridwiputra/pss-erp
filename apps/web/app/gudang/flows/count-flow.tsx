'use client';

import type { CycleCountResponse } from '@pss/contracts';
import { Button, MobileTaskTemplate, TextField, Toast } from '@pss/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../lib/api-client';

/** WMS-010.BR01: the system qty is never shown to the counter — `CycleCountResponse` never carries it, so there is nothing here that could leak it even by mistake. */
export function CountFlow({ warehouseId, switchModeAction }: { warehouseId: string; switchModeAction: ReactNode }) {
  const [locationCode, setLocationCode] = useState('');
  const [productId, setProductId] = useState('');
  const [uom, setUom] = useState('KARTON');
  const [countedQty, setCountedQty] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const submitCount = useMutation({
    mutationFn: () => gudangFetch<CycleCountResponse>('/gudang/hitung', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ warehouseId, locationCode, productId, uom, countedQty }),
    }),
    onSuccess: (result) => {
      setFeedback(result.varianceDetected ? 'Tersimpan · selisih dilaporkan ke supervisor' : 'Tersimpan · sesuai catatan');
      setProductId(''); setCountedQty('');
    },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal menyimpan hitungan.'),
  });

  return (
    <MobileTaskTemplate
      context="Hitung Stok"
      instruction="Hitung lokasi tanpa melihat catatan sistem"
      object={<TextField id="count-location" label="Lokasi (kode)" value={locationCode} onChange={(event) => setLocationCode(event.target.value)} required />}
      details={
        <>
          <TextField id="count-product" label="ID Produk" value={productId} onChange={(event) => setProductId(event.target.value)} required />
          <TextField id="count-uom" label="Satuan" value={uom} onChange={(event) => setUom(event.target.value)} required />
          <TextField id="count-qty" label="Jumlah dihitung" value={countedQty} onChange={(event) => setCountedQty(event.target.value)} inputMode="decimal" required />
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone={submitCount.isError ? 'danger' : 'success'} /> : undefined}
      action={<Button label="Simpan Hitungan" state={submitCount.isPending ? 'loading' : 'default'} disabled={!locationCode || !productId || !uom || !countedQty} onClick={() => submitCount.mutate()} />}
    />
  );
}
