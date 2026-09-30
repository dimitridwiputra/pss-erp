'use client';

import type { PosDashboardSummaryResponse, PosInvoiceCopyResponseSchema, PosSalesListResponse, PosSalesReportDetail } from '@pss/contracts';
import { EmptyState, KpiCard, LoadingState, PageHeader, Panel } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Banknote, ChevronLeft, ChevronRight, Printer, Receipt, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { ProblemNotice } from '../../kasir/components/problem-notice';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime, jakartaToday, saleStatusLabel } from '../../kasir/lib/labels';
import { quantity, rupiah } from '../../kasir/lib/money';

type Copy = z.infer<typeof PosInvoiceCopyResponseSchema>;
interface Filter { from: string; to: string; shiftId?: string; cashier?: { id: string; name: string }; page: number }

const PAGE_SIZE = 25;

/** A business date `days` before `date` (both YYYY-MM-DD, calendar arithmetic only). */
function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/** /kantor/penjualan: counter sales and their invoices (POS-015), detail, and an invoice copy marked SALINAN (BIL-001). */
export function PenjualanView() {
  const today = jakartaToday();
  const [filter, setFilter] = useState<Filter>({ from: today, to: today, page: 1 });
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ from: filter.from, to: filter.to, page: String(filter.page), pageSize: String(PAGE_SIZE) });
  if (filter.shiftId) params.set('shiftId', filter.shiftId);
  if (filter.cashier) params.set('cashierUserId', filter.cashier.id);
  const list = useQuery({ queryKey: ['pos-sales-report', params.toString()], queryFn: () => kasirFetch<PosSalesListResponse>(`/pos/reports/sales?${params}`), retry: false });
  const summary = useQuery({ queryKey: ['pos-summary', today], queryFn: () => kasirFetch<PosDashboardSummaryResponse>(`/pos/reports/summary?date=${today}`), retry: false });

  if (openId) return <BackofficeFrame title="Penjualan"><SaleDetail saleId={openId} onBack={() => setOpenId(null)} /></BackofficeFrame>;

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const presets = [
    { label: 'Hari ini', from: today, to: today },
    { label: 'Kemarin', from: daysBefore(today, 1), to: daysBefore(today, 1) },
    { label: '7 hari', from: daysBefore(today, 6), to: today },
    { label: '30 hari', from: daysBefore(today, 29), to: today },
  ];
  const kpiState = summary.isPending ? 'loading' : summary.isError ? 'error' : 'default';

  return (
    <BackofficeFrame title="Penjualan">
      <PageHeader eyebrow="Penjualan" title="Penjualan Konter" description="Transaksi kasir dan fakturnya. Buka nomor faktur untuk rincian dan cetak salinan." />

      {!summary.isError && (
        <dl className="pss-kpi-grid">
          <KpiCard icon={<Banknote />} tone="success" label="Penjualan hari ini" state={kpiState} value={summary.data ? rupiah(summary.data.salesTotal) : '—'} />
          <KpiCard icon={<Receipt />} tone="info" label="Transaksi hari ini" state={kpiState} value={summary.data ? String(summary.data.saleCount) : '—'} />
          <KpiCard icon={<Wallet />} tone={summary.data && summary.data.undepositedPaymentCount > 0 ? 'warning' : 'neutral'} label="Kas belum disetor" state={kpiState} value={summary.data ? rupiah(summary.data.undepositedCash) : '—'} />
        </dl>
      )}

      <Panel flush title="Daftar transaksi" description={list.data ? `${list.data.total} transaksi` : undefined}>
        <div className="pss-filter-bar">
          <div className="pss-segmented" role="group" aria-label="Rentang tanggal">
            {presets.map((preset) => {
              const active = filter.from === preset.from && filter.to === preset.to;
              return (
                <button key={preset.label} type="button" aria-pressed={active} className={active ? 'active' : undefined}
                  onClick={() => setFilter({ ...filter, from: preset.from, to: preset.to, page: 1 })}>{preset.label}</button>
              );
            })}
          </div>
          <label className="pss-date">Dari
            <input type="date" aria-label="Dari tanggal" value={filter.from} max={filter.to} onChange={(event) => setFilter({ ...filter, from: event.target.value, page: 1 })} />
          </label>
          <label className="pss-date">Sampai
            <input type="date" aria-label="Sampai tanggal" value={filter.to} min={filter.from} onChange={(event) => setFilter({ ...filter, to: event.target.value, page: 1 })} />
          </label>
          {(filter.cashier || filter.shiftId) && (
            <div className="pss-chips">
              {filter.cashier && <button type="button" aria-label={`Hapus saringan kasir ${filter.cashier.name}`}
                onClick={() => setFilter({ from: filter.from, to: filter.to, page: 1, ...(filter.shiftId ? { shiftId: filter.shiftId } : {}) })}>Kasir: {filter.cashier.name} <X size={14} /></button>}
              {filter.shiftId && <button type="button" aria-label="Hapus saringan shift"
                onClick={() => setFilter({ from: filter.from, to: filter.to, page: 1, ...(filter.cashier ? { cashier: filter.cashier } : {}) })}>Satu shift <X size={14} /></button>}
            </div>
          )}
        </div>

        {list.isPending && <div className="pss-panel-pad"><LoadingState label="Memuat penjualan" /></div>}
        {list.isError && <div className="pss-panel-pad"><BackofficeProblem error={list.error} onRetry={() => void list.refetch()} /></div>}
        {list.data && (list.data.items.length === 0
          ? <div className="pss-panel-pad"><EmptyState title="Belum ada penjualan" description="Tidak ada transaksi kasir pada rentang tanggal ini." /></div>
          : (
            <div className="pss-table-scroll">
              <table className="pss-data-table">
                <thead><tr><th>Waktu</th><th>No. Faktur</th><th>Kasir</th><th>Konter</th><th className="pss-number">Total</th><th>Keadaan</th></tr></thead>
                <tbody>
                  {list.data.items.map((item) => {
                    const state = saleStatusLabel[item.status] ?? { label: 'Lainnya', tone: 'blue' as const };
                    return (
                      <tr key={item.saleId}>
                        <td className="pss-muted">{jakartaDateTime(item.checkedOutAt)}</td>
                        <td><button type="button" className="pss-link pss-mono" onClick={() => setOpenId(item.saleId)}>{item.invoiceNumber}</button></td>
                        <td><button type="button" className="pss-link-quiet" title="Saring kasir ini" onClick={() => setFilter({ ...filter, cashier: { id: item.cashierUserId, name: item.cashierName ?? 'Kasir' }, page: 1 })}>{item.cashierName ?? 'Kasir'}</button></td>
                        <td><button type="button" className="pss-link-quiet" title="Saring shift ini" onClick={() => setFilter({ ...filter, shiftId: item.shiftId, page: 1 })}>{item.terminalName}</button></td>
                        <td className="pss-number"><strong>{rupiah(item.total)}</strong></td>
                        <td><span className={`pos-status pos-status-${state.tone}`}>{state.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        {list.data && list.data.total > PAGE_SIZE && (
          <nav className="pss-pagination" aria-label="Halaman">
            <span>Halaman {filter.page} dari {pages}</span>
            <div>
              <button className="pss-button pss-button-secondary" type="button" disabled={filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}><ChevronLeft size={16} aria-hidden="true" /> Sebelumnya</button>
              <button className="pss-button pss-button-secondary" type="button" disabled={filter.page >= pages} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>Berikutnya <ChevronRight size={16} aria-hidden="true" /></button>
            </div>
          </nav>
        )}
      </Panel>
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

  const back = <button className="pss-button pss-button-secondary" type="button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" /> Kembali ke Daftar</button>;
  if (detail.isPending) return <><PageHeader title="Rincian transaksi" actions={back} /><LoadingState label="Memuat transaksi" /></>;
  if (detail.isError) return <><PageHeader title="Rincian transaksi" actions={back} /><BackofficeProblem error={detail.error} onRetry={() => void detail.refetch()} /></>;
  const { sale } = detail.data;
  const state = saleStatusLabel[sale.status] ?? { label: 'Lainnya', tone: 'blue' as const };

  return (
    <>
      <PageHeader eyebrow="Penjualan Konter" title={sale.invoiceNumber ?? 'Transaksi'} actions={back}
        description={<span className={`pos-status pos-status-${state.tone}`}>{state.label}</span>} />
      <div className="pss-detail-grid">
        <Panel title="Barang">
          <dl className="pss-facts">
            <div><dt>Kasir</dt><dd>{detail.data.cashierName ?? 'Kasir'} · {detail.data.terminalName}</dd></div>
            <div><dt>Dibayar</dt><dd>{sale.tender ? jakartaDateTime(sale.tender.acceptedAt) : 'Belum dibayar'}</dd></div>
            <div><dt>Barang diambil</dt><dd>{detail.data.handedOverAt ? jakartaDateTime(detail.data.handedOverAt) : 'Belum diambil'}</dd></div>
          </dl>
          <table className="pss-data-table pss-lines">
            <thead><tr><th>Barang</th><th className="pss-number">Jumlah</th><th className="pss-number">Harga</th><th className="pss-number">Subtotal</th></tr></thead>
            <tbody>
              {sale.lines.map((line) => (
                <tr key={line.id}>
                  <td><strong>{line.name}</strong><small>{line.sku}</small></td>
                  <td className="pss-number">{quantity(line.qty)} {line.uom}</td>
                  <td className="pss-number">{rupiah(line.unitPrice)}</td>
                  <td className="pss-number">{rupiah(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pss-totals">
            <div className="pss-total-final"><span>Total</span><strong>{rupiah(sale.total)}</strong></div>
            {sale.tender && <div><span>Tunai diterima · kembalian</span><strong>{rupiah(sale.tender.cashReceived)} · {rupiah(sale.tender.changeAmount)}</strong></div>}
          </div>
        </Panel>

        <div className="pss-side-stack">
          {sale.tender && (
            <Panel title="Cetak Salinan" description="Salinan faktur selalu bertanda SALINAN dan dicatat bersama alasannya.">
              <label className="pss-form-field">Alasan
                <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} placeholder="Contoh: diminta pelanggan" />
              </label>
              <ProblemNotice error={print.error} />
              <button className="pss-button pss-button-primary pss-full" type="button" disabled={!reason.trim() || print.isPending} onClick={() => print.mutate({ reason: reason.trim() })}>
                <Printer size={18} aria-hidden="true" /> {print.isPending ? 'Sedang memproses…' : 'Cetak Salinan'}
              </button>
            </Panel>
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
      </div>
    </>
  );
}
