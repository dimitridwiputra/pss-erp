'use client';

import type { CashHandover, CashHandoverListResponse } from '@pss/contracts';
import { EmptyState, LoadingState, PageHeader, Panel } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { MoneyField } from '../../kasir/components/money-field';
import { ProblemNotice } from '../../kasir/components/problem-notice';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { cashVarianceReasons, handoverStatusLabel, jakartaDateTime, reasonLabel } from '../../kasir/lib/labels';
import { difference, rupiah } from '../../kasir/lib/money';

type Tab = 'DECLARED' | 'VERIFIED' | 'DISCREPANCY';
const tabs: { value: Tab; label: string }[] = [
  { value: 'DECLARED', label: 'Menunggu dihitung' },
  { value: 'VERIFIED', label: 'Sudah diterima' },
  { value: 'DISCREPANCY', label: 'Perlu keputusan' },
];

/**
 * /kantor/setoran-kas for the finance cashier (POS-014, CSH-001): the counter cash handovers
 * waiting to be counted, and their verification. A count that differs needs a registered reason
 * (MVP-OD-9); the server refuses the cashier who handed the money over (SOD-06).
 */
export function SetoranKasView() {
  const [tab, setTab] = useState<Tab>('DECLARED');
  const [open, setOpen] = useState<CashHandover | null>(null);
  const [done, setDone] = useState<CashHandover | null>(null);
  const list = useQuery({
    queryKey: ['cash-handovers', tab],
    queryFn: () => kasirFetch<CashHandoverListResponse>(`/payments/cash-handovers?status=${tab}&pageSize=50`),
    retry: false, refetchInterval: 20_000,
  });

  if (open) {
    return (
      <BackofficeFrame title="Setoran Kas">
        <Verify handover={open} onBack={() => setOpen(null)} onVerified={(result) => { setDone(result); setOpen(null); }} />
      </BackofficeFrame>
    );
  }

  return (
    <BackofficeFrame title="Setoran Kas">
      <PageHeader eyebrow="Kas" title="Setoran Kas Konter" description="Hitung uang dari kasir, lalu terima setorannya. Selisih perlu alasan." />
      {done && (
        <div className="pss-notice-success" role="status"><CheckCircle2 size={20} aria-hidden="true" />
          Setoran {done.shift?.terminalName ?? ''} {rupiah(done.countedAmount ?? done.declaredAmount)} sudah diterima.
        </div>
      )}
      <Panel flush title="Setoran dari kasir" description={list.data ? `${list.data.total} setoran` : undefined}
        actions={(
          <div className="pss-segmented" role="tablist" aria-label="Keadaan setoran">
            {tabs.map((item) => (
              <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} className={tab === item.value ? 'active' : undefined} onClick={() => setTab(item.value)}>{item.label}</button>
            ))}
          </div>
        )}>
        {list.isPending && <div className="pss-panel-pad"><LoadingState label="Memuat setoran" /></div>}
        {list.isError && <div className="pss-panel-pad"><BackofficeProblem error={list.error} onRetry={() => void list.refetch()} /></div>}
        {list.data && (list.data.items.length === 0
          ? <div className="pss-panel-pad"><EmptyState title={tab === 'DECLARED' ? 'Tidak ada setoran menunggu' : 'Belum ada setoran di sini'} description={tab === 'DECLARED' ? 'Semua uang dari kasir sudah dihitung.' : 'Setoran akan muncul di sini setelah dihitung.'} /></div>
          : (
            <div className="pss-table-scroll">
              <table className="pss-data-table">
                <thead><tr><th>Konter · Kasir</th><th>Diserahkan</th><th className="pss-number">Transaksi</th><th className="pss-number">Tercatat</th><th className="pss-number">Selisih</th><th>Keadaan</th></tr></thead>
                <tbody>
                  {list.data.items.map((item) => {
                    const state = handoverStatusLabel[item.status] ?? { label: 'Lainnya', tone: 'blue' as const };
                    const variance = item.varianceAmount && item.varianceAmount !== '0.00' ? item.varianceAmount : null;
                    return (
                      <tr key={item.id}>
                        <td>
                          {item.status === 'DECLARED'
                            ? <button type="button" className="pss-link" onClick={() => setOpen(item)}>{item.shift?.terminalName ?? 'Konter'} · {item.collectorName ?? 'Kasir'} <ChevronRight size={16} aria-hidden="true" /></button>
                            : <strong>{item.shift?.terminalName ?? 'Konter'} · {item.collectorName ?? 'Kasir'}</strong>}
                        </td>
                        <td className="pss-muted">{jakartaDateTime(item.declaredAt)}</td>
                        <td className="pss-number">{item.paymentCount}</td>
                        <td className="pss-number"><strong>{rupiah(item.declaredAmount)}</strong></td>
                        <td className="pss-number">{variance ? <span className={variance.startsWith('-') ? 'pss-negative' : undefined}>{rupiah(variance)}<small>{reasonLabel(item.reasonCode) ?? 'tanpa alasan'}</small></span> : '—'}</td>
                        <td><span className={`pos-status pos-status-${state.tone}`}>{state.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>
    </BackofficeFrame>
  );
}

function Verify({ handover, onBack, onVerified }: { handover: CashHandover; onBack: () => void; onVerified: (result: CashHandover) => void }) {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const variance = counted === '' ? null : difference(counted, handover.declaredAmount);
  const differs = variance !== null && variance !== '0.00';
  const verify = useCommand((input: { countedAmount: string; reasonCode?: string }, key) => kasirFetch<CashHandover>(`/payments/cash-handovers/${handover.id}/verify`, {
    method: 'POST', idempotencyKey: key, body: JSON.stringify(input),
  }), { onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ['cash-handovers'] }); onVerified(result); } });

  const closeVariance = handover.shift?.closeVariance;
  return (
    <>
      <PageHeader eyebrow="Setoran Kas" title="Hitung Setoran"
        description={`${handover.collectorName ?? 'Kasir'} menyerahkan uang penjualan ${handover.shift?.terminalName ?? 'konter'}.`}
        actions={<button className="pss-button pss-button-secondary" type="button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" /> Kembali ke Daftar</button>} />
      <div className="pss-detail-grid">
        <Panel title="Yang tercatat">
          <dl className="pss-facts">
            <div><dt>Tercatat di sistem</dt><dd><strong className="pss-big">{rupiah(handover.declaredAmount)}</strong></dd></div>
            <div><dt>Jumlah transaksi tunai</dt><dd>{handover.paymentCount}</dd></div>
            <div><dt>Diserahkan</dt><dd>{jakartaDateTime(handover.declaredAt)}</dd></div>
            {closeVariance && closeVariance !== '0.00' && handover.shift?.countedCash && (
              <div><dt>Hitungan kasir saat tutup shift</dt><dd>{rupiah(difference(handover.shift.countedCash, handover.shift.openingFloat))} ({closeVariance.startsWith('-') ? 'kurang' : 'lebih'} {rupiah(closeVariance.replace(/^-/, ''))})</dd></div>
            )}
          </dl>
        </Panel>
        <Panel title="Hitungan Anda" description="Hitung uang fisik yang Anda terima, lalu masukkan jumlahnya.">
          <div className="pos-kasir pss-count-form">
            <MoneyField label="Uang yang Anda hitung" value={counted} onChange={(value) => { setCounted(value); setReasonCode(null); }} autoFocus />
            {differs && variance && (
              <fieldset className="pos-field">
                <legend>Uang {variance.startsWith('-') ? 'kurang' : 'lebih'} {rupiah(variance.replace(/^-/, ''))} dari yang tercatat. Kenapa?</legend>
                <div className="pos-methods">
                  {cashVarianceReasons.map((reason) => (
                    <button key={reason.code} type="button" aria-pressed={reasonCode === reason.code} className={reasonCode === reason.code ? 'selected' : ''} onClick={() => setReasonCode(reason.code)}>{reason.label}</button>
                  ))}
                </div>
              </fieldset>
            )}
            <ProblemNotice error={verify.error} />
            <button className="pss-button pss-button-primary pss-full pss-tall" type="button" disabled={counted === '' || (differs && !reasonCode) || verify.isPending}
              onClick={() => verify.mutate(differs && reasonCode ? { countedAmount: counted, reasonCode } : { countedAmount: counted })}>
              {verify.isPending ? 'Sedang memproses…' : `Terima Setoran ${counted === '' ? '' : rupiah(counted)}`}
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}
