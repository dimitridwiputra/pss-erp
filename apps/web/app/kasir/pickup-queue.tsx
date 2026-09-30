'use client';

import type { PosPickupListResponse } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Package, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { ProblemNotice } from './components/problem-notice';
import { useCommand } from './hooks/use-command';
import { kasirFetch } from './lib/api-client';
import { quantity, rupiah } from './lib/money';

type Pickup = PosPickupListResponse['items'][number];

/**
 * POS-010 Serah Barang for warehouse staff: SCAN → CONFIRM → NEXT. The queue is every paid counter
 * sale waiting in the caller's warehouse; scanning the receipt number picks it. The server refuses
 * the cashier who took the money (SOD-09), so this screen needs no rule of its own.
 */
export function PickupQueue() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [selected, setSelected] = useState<Pickup | null>(null);
  const [receiverName, setReceiverName] = useState('');
  const [done, setDone] = useState<{ invoiceNumber: string } | null>(null);

  const pickups = useQuery({ queryKey: ['pos-pickups'], queryFn: () => kasirFetch<PosPickupListResponse>('/pos/pickups'), refetchInterval: 15_000 });

  const handover = useCommand(
    (input: { saleId: string; receiverName: string }, key) => kasirFetch<{ invoiceNumber: string }>(`/pos/sales/${input.saleId}/pickup-handover`, {
      method: 'POST', idempotencyKey: key, body: JSON.stringify({ receiverName: input.receiverName }),
    }),
    { onSuccess: async (result) => { setDone(result); setSelected(null); setReceiverName(''); await queryClient.invalidateQueries({ queryKey: ['pos-pickups'] }); } },
  );

  function pickByCode() {
    const match = pickups.data?.items.find((item) => item.invoiceNumber.toUpperCase() === code.trim().toUpperCase());
    if (match) { setSelected(match); setCode(''); setDone(null); }
  }

  if (pickups.isPending) return <LoadingState label="Memuat barang yang menunggu diambil" />;
  if (pickups.isError) return <ProblemNotice error={pickups.error} action={<button className="pos-outline" type="button" onClick={() => void pickups.refetch()}>Coba Lagi</button>} />;

  if (selected) {
    return (
      <section className="pos-card pos-kasir-narrow" aria-labelledby="pickup-title">
        <h2 id="pickup-title">Serahkan Barang</h2>
        <p className="pos-muted">Struk {selected.invoiceNumber} · {rupiah(selected.total)}</p>
        <ul className="pos-pickup-lines">
          {selected.lines.map((line) => <li key={line.id}><strong>{quantity(line.qty)} {line.uom}</strong> {line.name}<small>{line.sku}</small></li>)}
        </ul>
        <label className="pos-field">Nama penerima
          <input value={receiverName} onChange={(event) => setReceiverName(event.target.value)} autoComplete="off" maxLength={120} />
        </label>
        <ProblemNotice error={handover.error} />
        <div className="pos-footer-actions">
          <button className="pos-outline" type="button" onClick={() => { setSelected(null); handover.reset(); }}>Kembali</button>
          <button className="pos-primary" type="button" disabled={!receiverName.trim() || handover.isPending}
            onClick={() => handover.mutate({ saleId: selected.saleId, receiverName: receiverName.trim() })}>
            {handover.isPending ? 'Sedang memproses…' : 'Serahkan Barang'}
          </button>
        </div>
      </section>
    );
  }

  const items = pickups.data.items;
  return (
    <>
      {done && <div className="pos-inline-success" role="status"><CheckCircle2 size={20} /> Barang untuk struk {done.invoiceNumber} sudah diserahkan.</div>}
      <section className="pos-card" aria-labelledby="queue-title">
        <div className="pos-card-title"><h2 id="queue-title">Menunggu Diambil <b>{items.length}</b></h2></div>
        <form className="pos-toolbar" onSubmit={(event) => { event.preventDefault(); pickByCode(); }}>
          <label className="pos-search"><ScanLine size={20} />
            <input aria-label="Scan nomor struk" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Scan atau ketik nomor struk" autoFocus />
          </label>
          <button className="pos-outline" type="submit">Cari Struk</button>
        </form>
        {items.length === 0
          ? <EmptyState title="Tidak ada barang menunggu" description="Semua pembayaran di konter sudah diserahkan barangnya." />
          : items.map((item) => (
            <button type="button" className="pos-action-row" key={item.saleId} onClick={() => { setSelected(item); setDone(null); }}>
              <span className="pos-icon-box"><Package size={22} /></span>
              <span><strong>{item.invoiceNumber}</strong><small>{item.lines.length} barang · {rupiah(item.total)}</small></span>
            </button>
          ))}
      </section>
    </>
  );
}
