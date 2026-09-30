'use client';

import type { CashHandover, CashHandoverListResponse } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Wallet } from 'lucide-react';
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
 * (MVP-OD-26); the server refuses the cashier who handed the money over (SOD-06).
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
      <div className="pos-page-heading"><div><h1>Setoran Kas Konter</h1><p>Hitung uang dari kasir, lalu terima setorannya.</p></div></div>
      {done && (
        <div className="pos-inline-success" role="status"><CheckCircle2 size={20} />
          Setoran {done.shift?.terminalName ?? ''} {rupiah(done.countedAmount ?? done.declaredAmount)} sudah diterima.
        </div>
      )}
      <div className="pos-chips" role="tablist" aria-label="Keadaan setoran">
        {tabs.map((item) => (
          <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} className={tab === item.value ? 'selected' : ''} onClick={() => setTab(item.value)}>{item.label}</button>
        ))}
      </div>
      <section className="pos-card">
        {list.isPending && <LoadingState label="Memuat setoran" />}
        {list.isError && <BackofficeProblem error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && (list.data.items.length === 0
          ? <EmptyState title={tab === 'DECLARED' ? 'Tidak ada setoran menunggu' : 'Belum ada setoran di sini'} description={tab === 'DECLARED' ? 'Semua uang dari kasir sudah dihitung.' : 'Setoran akan muncul di sini setelah dihitung.'} />
          : list.data.items.map((item) => {
            const state = handoverStatusLabel[item.status] ?? { label: 'Lainnya', tone: 'blue' as const };
            return (
              <button type="button" className="pos-action-row" key={item.id} disabled={item.status !== 'DECLARED'} onClick={() => setOpen(item)}>
                <span className="pos-icon-box"><Wallet size={22} /></span>
                <span>
                  <strong>{item.shift?.terminalName ?? 'Konter'} · {item.collectorName ?? 'Kasir'}</strong>
                  <small>{rupiah(item.declaredAmount)} tercatat · {item.paymentCount} transaksi · {jakartaDateTime(item.declaredAt)}</small>
                  {item.varianceAmount && item.varianceAmount !== '0.00' && <small>Selisih {rupiah(item.varianceAmount)} · {reasonLabel(item.reasonCode) ?? 'tanpa alasan'}</small>}
                </span>
                <span className={`pos-status pos-status-${state.tone}`}>{state.label}</span>
              </button>
            );
          }))}
      </section>
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
    <div className="pos-kasir-narrow">
      <button className="pos-outline" type="button" onClick={onBack}><ArrowLeft size={18} /> Kembali ke Daftar</button>
      <section className="pos-card" aria-labelledby="verify-title">
        <h2 id="verify-title">Hitung Setoran</h2>
        <p className="pos-instruction">{handover.collectorName ?? 'Kasir'} menyerahkan uang penjualan {handover.shift?.terminalName ?? 'konter'}.</p>
        <dl className="pos-definition">
          <div><dt>Tercatat di sistem</dt><dd><strong>{rupiah(handover.declaredAmount)}</strong></dd></div>
          <div><dt>Jumlah transaksi tunai</dt><dd>{handover.paymentCount}</dd></div>
          {closeVariance && closeVariance !== '0.00' && handover.shift?.countedCash && (
            <div><dt>Hitungan kasir saat tutup shift</dt><dd>{rupiah(difference(handover.shift.countedCash, handover.shift.openingFloat))} ({closeVariance.startsWith('-') ? 'kurang' : 'lebih'} {rupiah(closeVariance.replace(/^-/, ''))})</dd></div>
          )}
        </dl>
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
        <button className="pos-primary" type="button" disabled={counted === '' || (differs && !reasonCode) || verify.isPending}
          onClick={() => verify.mutate(differs && reasonCode ? { countedAmount: counted, reasonCode } : { countedAmount: counted })}>
          {verify.isPending ? 'Sedang memproses…' : `Terima Setoran ${counted === '' ? '' : rupiah(counted)}`}
        </button>
      </section>
    </div>
  );
}
