'use client';

import type { ReceiveGoodsResponse } from '@pss/contracts';
import { Button, MobileTaskTemplate, TextField, Toast } from '@pss/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../lib/api-client';

export function ReceiveFlow({ warehouseId, switchModeAction }: { warehouseId: string; switchModeAction: ReactNode }) {
  const [locationCode, setLocationCode] = useState('');
  const [productId, setProductId] = useState('');
  const [uom, setUom] = useState('KARTON');
  const [qty, setQty] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const receive = useMutation({
    mutationFn: () => gudangFetch<ReceiveGoodsResponse>('/gudang/terima', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({
        warehouseId, locationCode, referenceType: 'WMS_RECEIVING', referenceId: crypto.randomUUID(),
        lines: [{ productId, uom, qty }],
      }),
    }),
    onSuccess: () => {
      setFeedback(`Diterima · tugas putaway dibuat`);
      setProductId(''); setQty('');
    },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal menerima barang.'),
  });

  return (
    <MobileTaskTemplate
      context="Terima Barang"
      instruction="Scan barang yang diterima"
      object={<TextField id="receive-location" label="Lokasi Penerimaan (kode)" value={locationCode} onChange={(event) => setLocationCode(event.target.value)} required />}
      details={
        <>
          <TextField id="receive-product" label="ID Produk" value={productId} onChange={(event) => setProductId(event.target.value)} required />
          <TextField id="receive-uom" label="Satuan" value={uom} onChange={(event) => setUom(event.target.value)} required />
          <TextField id="receive-qty" label="Qty" value={qty} onChange={(event) => setQty(event.target.value)} inputMode="decimal" required />
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone={receive.isError ? 'danger' : 'success'} /> : undefined}
      action={<Button label="Konfirmasi Terima" state={receive.isPending ? 'loading' : 'default'} disabled={!locationCode || !productId || !uom || !qty} onClick={() => receive.mutate()} />}
    />
  );
}
