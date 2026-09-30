'use client';

import type { PosInvoiceCopyResponseSchema, PosSalesListResponse, PosSalesReportDetail } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, X } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { ProblemNotice } from '../../kasir/components/problem-notice';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime, jakartaToday, saleStatusLabel } from '../../kasir/lib/labels';
import { quantity, rupiah } from '../../kasir/lib/money';

type Copy = z.infer<typeof PosInvoiceCopyResponseSchema>;
interface Filter { from: string; to: string; shiftId?: string; cashier?: { id: string; name: string } ; page: number }

const PAGE_SIZE = 25;

/** /kantor/penjualan: counter sales and their invoices (POS-015), detail, and an invoice copy marked SALINAN (BIL-001). */
export function PenjualanView() {
  const today = jakartaToday();
  const [filter, setFilter] = useState<Filter>({ from: today, to: today, page: 1 });
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ from: filter.from, to: filter.to, page: String(filter.page), pageSize: String(PAGE_SIZE) });
  if (filter.shiftId) params.set('shiftId', filter.shiftId);
  if (filter.cashier) params.set('cashierUserId', filter.cashier.id);
  const list = useQuery({ queryKey: ['pos-sales-report', params.toString()], queryFn: () => kasirFetch<PosSalesListResponse>(`/pos/reports/sales?${params}`), retry: false });

  if (openId) return <BackofficeFrame title="Penjualan"><SaleDetail saleId={openId} onBack={() => setOpenId(null)} /></BackofficeFrame>;

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  return (
    <BackofficeFrame title="Penjualan">
      <div className="pos-page-heading"><div><h1>Penjualan Konter</h1><p>Transaksi kasir dan fakturnya.</p></div></div>
      <section className="pos-card">
        <form className="pos-toolbar pos-filter-row" onSubmit={(event) => event.preventDefault()}>
          <label className="pos-field">Dari tanggal
            <input type="date" value={filter.from} max={filter.to} onChange={(event) => setFilter({ ...filter, from: event.target.value, page: 1 })} />
          </label>
          <label className="pos-field">Sampai tanggal
            <input type="date" value={filter.to} min={filter.from} onChange={(event) => setFilter({ ...filter, to: event.target.value, page: 1 })} />
          </label>
        </form>
        {(filter.cashier || filter.shiftId) && (
          <div className="pos-chips">
            {filter.cashier && <button type="button" aria-label={`Hapus saringan kasir ${filter.cashier.name}`}
              onClick={() => setFilter({ from: filter.from, to: filter.to, page: 1, ...(filter.shiftId ? { shiftId: filter.shiftId } : {}) })}>Kasir: {filter.cashier.name} <X size={14} /></button>}
            {filter.shiftId && <button type="button" aria-label="Hapus saringan shift"
              onClick={() => setFilter({ from: filter.from, to: filter.to, page: 1, ...(filter.cashier ? { cashier: filter.cashier } : {}) })}>Satu shift <X size={14} /></button>}
          </div>
        )}
        {list.isPending && <LoadingState label="Memuat penjualan" />}
        {list.isError && <BackofficeProblem error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && (list.data.items.length === 0
          ? <EmptyState title="Belum ada penjualan" description="Tidak ada transaksi kasir pada tanggal ini." />
          : (
            <div className="pos-table-wrap">
              <table className="pos-table">
                <thead><tr><th>Waktu</th><th>No. Faktur</th><th>Kasir</th><th>Konter</th><th className="pos-number">Total</th><th>Keadaan</th></tr></thead>
                <tbody>
                  {list.data.items.map((item) => {
                    const state = saleStatusLabel[item.status] ?? { label: 'Lainnya', tone: 'blue' as const };
                    return (
                      <tr key={item.saleId}>
                        <td>{jakartaDateTime(item.checkedOutAt)}</td>
                        <td><button type="button" className="pos-linkish" onClick={() => setOpenId(item.saleId)}>{item.invoiceNumber}</button></td>
                        <td><button type="button" className="pos-linkish" onClick={() => setFilter({ ...filter, cashier: { id: item.cashierUserId, name: item.cashierName ?? 'Kasir' }, page: 1 })}>{item.cashierName ?? 'Kasir'}</button></td>
                        <td><button type="button" className="pos-linkish" onClick={() => setFilter({ ...filter, shiftId: item.shiftId, page: 1 })}>{item.terminalName}</button></td>
                        <td className="pos-number">{rupiah(item.total)}</td>
                        <td><span className={`pos-status pos-status-${state.tone}`}>{state.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        {list.data && list.data.total > PAGE_SIZE && (
          <nav className="pos-pagination" aria-label="Halaman">
            <button className="pos-outline" type="button" disabled={filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>Sebelumnya</button>
            <span>Halaman {filter.page} dari {pages}</span>
            <button className="pos-outline" type="button" disabled={filter.page >= pages} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>Berikutnya</button>
          </nav>
        )}
      </section>
    </BackofficeFrame>
  );
}

function SaleDetail({ saleId, onBack }: { saleId: string; onBack: () => void }) {
  const detail = useQuery({ queryKey: ['pos-sales-report-detail', saleId], queryFn: () => kasirFetch<PosSalesReportDetail>(`/pos/reports/sales/${saleId}`), retry: false });
  const [reason, setReason] = useState('');
  const [copy, setCopy] = useState<Copy | null>(null);
  const print = useCommand((input: { reason: string }, key) => kasirFetch<Copy>(`/pos/reports/sales/${saleId}/copies`, {
    method: 'POST', idempotencyKey: key, body: JSON.stringify(input),
  }), { onSuccess: (result) => { setCopy(result); setReason(''); window.setTimeout(() => window.print(), 50); } });

  if (detail.isPending) return <LoadingState label="Memuat transaksi" />;
  if (detail.isError) return <BackofficeProblem error={detail.error} onRetry={() => void detail.refetch()} />;
  const { sale } = detail.data;
  const state = saleStatusLabel[sale.status] ?? { label: 'Lainnya', tone: 'blue' as const };

  return (
    <div className="pos-kasir-narrow">
      <button className="pos-outline" type="button" onClick={onBack}><ArrowLeft size={18} /> Kembali ke Daftar</button>
      <section className="pos-card pos-detail-card">
        <div className="pos-card-title"><h2>{sale.invoiceNumber}</h2><span className={`pos-status pos-status-${state.tone}`}>{state.label}</span></div>
        <dl className="pos-definition">
          <div><dt>Kasir</dt><dd>{detail.data.cashierName ?? 'Kasir'} · {detail.data.terminalName}</dd></div>
          <div><dt>Dibayar</dt><dd>{sale.tender ? jakartaDateTime(sale.tender.acceptedAt) : 'Belum dibayar'}</dd></div>
          <div><dt>Barang diambil</dt><dd>{detail.data.handedOverAt ? jakartaDateTime(detail.data.handedOverAt) : 'Belum diambil'}</dd></div>
        </dl>
        <ul className="pos-pickup-lines">{sale.lines.map((line) => <li key={line.id}><strong>{quantity(line.qty)} {line.uom} {line.name}</strong><small>{line.sku} · {rupiah(line.unitPrice)} · {rupiah(line.lineTotal)}</small></li>)}</ul>
        <div className="pos-total pos-total-final"><span>Total</span><strong>{rupiah(sale.total)}</strong></div>
        {sale.tender && <div className="pos-total"><span>Tunai diterima · kembalian</span><strong>{rupiah(sale.tender.cashReceived)} · {rupiah(sale.tender.changeAmount)}</strong></div>}
      </section>
      {sale.tender && (
        <section className="pos-card">
          <h2>Cetak Salinan</h2>
          <label className="pos-field">Alasan
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} placeholder="Contoh: diminta pelanggan" />
          </label>
          <ProblemNotice error={print.error} />
          <button className="pos-primary" type="button" disabled={!reason.trim() || print.isPending} onClick={() => print.mutate({ reason: reason.trim() })}>
            <Printer size={18} /> {print.isPending ? 'Sedang memproses…' : 'Cetak Salinan'}
          </button>
        </section>
      )}
      {copy && (
        <article className="pos-card pos-receipt" aria-label="Salinan faktur">
          <p className="pos-receipt-copy">SALINAN</p>
          <h3>{copy.terminalName}</h3>
          <p className="pos-muted">{copy.invoiceNumber} · {jakartaDateTime(copy.paidAt)}</p>
          <ul>{copy.lines.map((line) => <li key={line.id}><span>{quantity(line.qty)} {line.uom} {line.name}</span><b>{rupiah(line.lineTotal)}</b></li>)}</ul>
          <div className="pos-total pos-total-final"><span>Total</span><strong>{rupiah(copy.total)}</strong></div>
        </article>
      )}
    </div>
  );
}
