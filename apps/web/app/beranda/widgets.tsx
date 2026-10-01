'use client';

import type { PosDashboardSummaryResponse, PosSalesTrendResponse } from '@pss/contracts';
import { KpiCard, Panel, TrendLineChart } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Banknote, BookOpenCheck, Receipt, TrendingUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import type { ComponentType } from 'react';
import { kasirFetch } from '../kasir/lib/api-client';
import { rupiah } from '../kasir/lib/money';
import { useFinanceData } from '../keuangan/finance-client';

/**
 * Beranda widgets, each shown when the viewer can open the work screen it summarises (the key of a
 * work screen in lib/navigation/work-screens.ts, so the permission rule lives in one place).
 * Append-only for the other streams: stock value (OpenCode), gross profit and trial balance (Codex).
 */
const homeWidgets: ReadonlyArray<{ key: string; screen: string; Widget: ComponentType }> = [
  { key: 'pos-sales', screen: 'penjualan', Widget: CounterSalesWidget },
  { key: 'finance-gross-profit', screen: 'keuangan', Widget: FinanceGrossProfitWidget },
  { key: 'finance-trial-balance', screen: 'keuangan', Widget: FinanceTrialBalanceWidget },
];

export function HomeWidgets({ screenKeys }: { screenKeys: readonly string[] }) {
  const visible = homeWidgets.filter((widget) => screenKeys.includes(widget.screen));
  if (visible.length === 0) return null;
  return <>{visible.map(({ key, Widget }) => <Widget key={key} />)}</>;
}

function FinanceGrossProfitWidget() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const summary = useFinanceData<{ grossProfitToday: string; grossProfitMonthToDate: string }>(`finance/summary?businessDate=${today}`);
  const state = summary.loading ? 'loading' : summary.error ? 'error' : 'default';
  return <section className="home-widget" aria-labelledby="home-finance-profit-title">
    <div className="home-widget-head"><h2 id="home-finance-profit-title">Laba kotor</h2><Link className="home-widget-link" href="/keuangan">Buka Keuangan</Link></div>
    <dl className="pss-kpi-grid">
      <KpiCard icon={<Banknote />} tone="success" label="Hari ini" value={summary.data ? rupiah(summary.data.grossProfitToday) : '—'} state={state} />
      <KpiCard icon={<TrendingUp />} label="Bulan berjalan" value={summary.data ? rupiah(summary.data.grossProfitMonthToDate) : '—'} state={state} />
    </dl>
  </section>;
}

function FinanceTrialBalanceWidget() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const balance = useFinanceData<{ totalDebit: string; totalCredit: string; balanced: boolean }>(`finance/trial-balance?through=${today}`);
  return <section className="home-widget" aria-labelledby="home-finance-balance-title">
    <div className="home-widget-head"><h2 id="home-finance-balance-title">Neraca saldo</h2><Link className="home-widget-link" href="/keuangan/neraca-saldo">Lihat neraca saldo</Link></div>
    <dl className="pss-kpi-grid"><KpiCard icon={<BookOpenCheck />} tone={balance.data?.balanced ? 'success' : 'warning'}
      label="Keseimbangan jurnal" value={balance.data ? balance.data.balanced ? 'Seimbang' : 'Perlu diperiksa' : '—'}
      state={balance.loading ? 'loading' : balance.error ? 'error' : 'default'} /></dl>
    {balance.data && <p className="home-widget-note">Debit {rupiah(balance.data.totalDebit)} · Kredit {rupiah(balance.data.totalCredit)}</p>}
  </section>;
}

const shortDate = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Counter sales today, cash not yet counted by Finance, and the last 7 days (POS-015). */
function CounterSalesWidget() {
  const summary = useQuery({ queryKey: ['home-pos-summary'], queryFn: () => kasirFetch<PosDashboardSummaryResponse>('/pos/reports/summary'), retry: false });
  const trend = useQuery({ queryKey: ['home-pos-trend'], queryFn: () => kasirFetch<PosSalesTrendResponse>('/pos/reports/sales-trend?days=7'), retry: false });
  const kpiState = summary.isPending ? 'loading' : summary.isError ? 'error' : 'default';

  return (
    <section className="home-widget" aria-labelledby="home-pos-title">
      <div className="home-widget-head">
        <h2 id="home-pos-title">Penjualan konter</h2>
        <Link className="home-widget-link" href="/kantor/penjualan">Lihat semua transaksi</Link>
      </div>
      <dl className="pss-kpi-grid">
        <KpiCard icon={<Banknote />} tone="success" label="Penjualan hari ini" state={kpiState} value={summary.data ? rupiah(summary.data.salesTotal) : '—'} />
        <KpiCard icon={<Receipt />} tone="info" label="Transaksi hari ini" state={kpiState} value={summary.data ? String(summary.data.saleCount) : '—'} />
        <KpiCard icon={<Wallet />} tone={summary.data && summary.data.undepositedPaymentCount > 0 ? 'warning' : 'neutral'} label="Kas belum disetor" state={kpiState}
          value={summary.data ? rupiah(summary.data.undepositedCash) : '—'}
          {...(summary.data && summary.data.undepositedPaymentCount > 0 ? { delta: { direction: 'up' as const, tone: 'neutral' as const, label: `${summary.data.undepositedPaymentCount} pembayaran menunggu dihitung` } } : {})} />
      </dl>
      <Panel title="7 hari terakhir" description="Penjualan tunai yang sudah dibayar, per tanggal.">
        {trend.isPending && <span className="pss-skeleton-row" aria-label="Memuat grafik" />}
        {trend.isError && <p className="home-widget-note">Grafik belum dapat dimuat. Muat ulang halaman untuk mencoba lagi.</p>}
        {trend.data && (
          <TrendLineChart points={trend.data.points.map((point) => ({
            label: shortDate.format(new Date(`${point.businessDate}T00:00:00Z`)),
            // A chart position only; every amount shown as text stays a decimal string.
            value: Number(point.salesTotal),
          }))} />
        )}
      </Panel>
    </section>
  );
}
