'use client';

import type { CheckoutPosSaleResponse, KasirShiftSayaResponse, PosSaleLineResponse } from '@pss/contracts';
import {
  enqueueOfflineSale, openPosOfflineDatabase, syncPosOfflineBatch,
  type CachedCatalogEntry,
} from '@pss/offline';
import { Button, CounterTemplate, StatusPill, TextField } from '@pss/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import { useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './hooks/use-online-status';
import { kasirFetch, newIdempotencyKey } from './lib/api-client';

type Step = 'NO_SHIFT' | 'CART' | 'TENDER' | 'DONE';

function sum(lines: PosSaleLineResponse[]): string {
  return lines.reduce((total, line) => total.plus(line.lineTotal), new Decimal(0)).toFixed(2);
}

export function KasirCounter() {
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const db = openPosOfflineDatabase();

  const [terminalId, setTerminalId] = useState('');
  const [openingFloat, setOpeningFloat] = useState('500000');
  const [barcode, setBarcode] = useState('');
  const [saleId, setSaleId] = useState<string | null>(null);
  const [lines, setLines] = useState<PosSaleLineResponse[]>([]);
  const [cashReceived, setCashReceived] = useState('');
  const [checkout, setCheckout] = useState<CheckoutPosSaleResponse | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const shiftSaya = useQuery({
    queryKey: ['kasir-shift-saya'],
    queryFn: () => kasirFetch<KasirShiftSayaResponse>('/kasir/shift-saya'),
    enabled: online,
    retry: false,
  });

  useEffect(() => { scanRef.current?.focus(); });

  const effectiveTerminalId = shiftSaya.data?.shift?.terminalId ?? terminalId;
  const step: Step = checkout ? 'TENDER' : shiftSaya.data?.shift ? 'CART' : online ? 'NO_SHIFT' : 'CART';

  const openShift = useMutation({
    mutationFn: () => kasirFetch('/pos/shifts', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ terminalId, openingFloat }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kasir-shift-saya'] }),
  });

  async function handleScan() {
    const code = barcode.trim();
    setBarcode('');
    if (!code) return;
    if (online) {
      let sid = saleId;
      if (!sid) {
        const created = await kasirFetch<{ id: string }>('/pos/sales', {
          method: 'POST', idempotencyKey: newIdempotencyKey(),
          body: JSON.stringify({ terminalId: effectiveTerminalId, shiftId: shiftSaya.data?.shift?.id }),
        });
        sid = created.id;
        setSaleId(sid);
      }
      const line = await kasirFetch<PosSaleLineResponse>(`/pos/sales/${sid}/lines`, {
        method: 'POST', idempotencyKey: newIdempotencyKey(), body: JSON.stringify({ barcode: code }),
      });
      setLines((current) => [...current, line]);
    } else {
      const cached = await db.catalog.where('barcode').equals(code).first();
      if (!cached) { setFeedback('Barang tidak ditemukan di katalog offline.'); return; }
      setLines((current) => appendOrMergeOfflineLine(current, cached));
    }
  }

  const doCheckout = useMutation({
    mutationFn: () => kasirFetch<CheckoutPosSaleResponse>(`/pos/sales/${saleId}/checkout`, {
      method: 'POST', idempotencyKey: saleId ?? newIdempotencyKey(),
    }),
    onSuccess: (result: CheckoutPosSaleResponse) => setCheckout(result),
  });

  const acceptTender = useMutation({
    mutationFn: () => kasirFetch(`/pos/sales/${saleId}/tenders`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ method: 'TUNAI', cashReceived }),
    }),
    onSuccess: () => resetForNextSale(),
  });

  async function handleBayar() {
    if (online) { doCheckout.mutate(); return; }
    await enqueueOfflineSale(db, {
      number: `OFFLINE-${Date.now()}`,
      customerId: null,
      lines: lines.map((line) => ({ productId: line.productId, uom: line.uom, sku: line.sku, name: line.name, qty: line.qty })),
      cashReceived,
    });
    setFeedback('Tersimpan · menunggu sinkronisasi');
    resetForNextSale();
  }

  function resetForNextSale() {
    setSaleId(null);
    setLines([]);
    setCashReceived('');
    setCheckout(null);
  }

  useEffect(() => {
    if (!online) return;
    void (async () => {
      const result = await syncPosOfflineBatch(db, {
        terminalId: effectiveTerminalId, endpoint: '/kasir/sync', idempotencyKey: newIdempotencyKey(),
      }).catch(() => null);
      if (result) queryClient.invalidateQueries({ queryKey: ['kasir-shift-saya'] });
    })();
  }, [online, db, effectiveTerminalId, queryClient]);

  const total = checkout?.total ?? sum(lines);
  const change = cashReceived ? new Decimal(cashReceived || '0').minus(total).toFixed(2) : null;

  if (step === 'NO_SHIFT') {
    return (
      <main className="pss-page-template pss-mobile-task">
        <header className="pss-template-header"><h1>Buka Shift</h1></header>
        <section className="pss-template-panel">
          <TextField id="terminal" label="Terminal" value={terminalId} onChange={(event) => setTerminalId(event.target.value)} required />
          <TextField id="modal" label="Modal laci (Rp)" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} required />
        </section>
        <footer className="pss-mobile-action">
          <Button label="Buka Shift" state={openShift.isPending ? 'loading' : 'default'} onClick={() => openShift.mutate()} />
        </footer>
      </main>
    );
  }

  if (step === 'TENDER' && checkout) {
    return (
      <CounterTemplate
        context={`Konter · Terminal ${effectiveTerminalId}`}
        scan={<p>Total Rp{checkout.total} · Faktur {checkout.invoiceNumber}</p>}
        lines={<ul>{lines.map((line) => <li key={line.id}>{line.name} · {line.qty} {line.uom}</li>)}</ul>}
        summary={
          <dl>
            <dt>Total</dt><dd>Rp{checkout.total}</dd>
            <dt>Diterima</dt><dd><TextField id="cash-received" label="Uang diterima" value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} /></dd>
            {change && <><dt>Kembalian</dt><dd>Rp{change}</dd></>}
          </dl>
        }
        primaryAction={<Button label="Terima Uang" state={acceptTender.isPending ? 'loading' : 'default'} disabled={!cashReceived || Number(change) < 0} onClick={() => acceptTender.mutate()} />}
      />
    );
  }

  return (
    <CounterTemplate
      context={`Konter · Terminal ${effectiveTerminalId}`}
      status={<StatusPill label={online ? 'Shift Berjalan' : 'Mode Darurat · Tunai Saja'} tone={online ? 'info' : 'warning'} />}
      scan={<TextField id="scan" label="Scan barang" ref={scanRef} value={barcode} onChange={(event) => setBarcode(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void handleScan(); }} />}
      lines={<ul>{lines.map((line) => <li key={line.id}>{line.name} · {line.qty} {line.uom} · Rp{line.lineTotal}</li>)}</ul>}
      summary={<dl><dt>Total</dt><dd>Rp{total}</dd></dl>}
      feedback={feedback}
      primaryAction={<Button label="Bayar" state={doCheckout.isPending ? 'loading' : 'default'} disabled={lines.length === 0} onClick={() => void handleBayar()} />}
    />
  );
}

function appendOrMergeOfflineLine(current: PosSaleLineResponse[], cached: CachedCatalogEntry): PosSaleLineResponse[] {
  const existingIndex = current.findIndex((line) => line.productId === cached.productId && line.uom === cached.uom);
  if (existingIndex === -1) {
    const line: PosSaleLineResponse = {
      id: crypto.randomUUID(), productId: cached.productId, sku: cached.sku, name: cached.name,
      uom: cached.uom, qty: '1', unitPrice: cached.unitPrice, lineTotal: cached.unitPrice,
    };
    return [...current, line];
  }
  const existing = current[existingIndex]!;
  const qty = new Decimal(existing.qty).plus(1).toString();
  const lineTotal = new Decimal(existing.unitPrice).times(qty).toFixed(2);
  const updated = [...current];
  updated[existingIndex] = { ...existing, qty, lineTotal };
  return updated;
}
