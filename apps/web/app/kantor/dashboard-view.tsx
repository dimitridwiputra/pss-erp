'use client';

import { EmptyState, KpiCard, PageHeader } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Boxes, Coins, PackageSearch, RefreshCw, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { quantity, rupiah } from '../kasir/lib/money';
import type { DashboardTile, KantorDashboard } from '../../lib/kantor/dashboard';
import { kantorFetch } from './lib/client';

/**
 * Dasbor Harian — the /kantor home screen.
 *
 * A dashboard owns no rule: it renders what `lib/kantor/dashboard.ts` composed from other domains'
 * published reads. Nothing here computes a figure, sums two answers, or infers a business meaning
 * (MVP_PLAN §4, §7) — including the gross-profit tile, which reads Finance rather than deriving a
 * margin from a sale and a cost here.
 */
export function DashboardView() {
  const dashboard = useQuery({
    queryKey: ['kantor-dashboard'],
    queryFn: () => kantorFetch<KantorDashboard>('/api/kantor/dashboard'),
    // The morning's numbers move; a reload should not need a full page refresh to see a sale land.
    refetchInterval: 60_000,
    retry: false,
  });
  const data = dashboard.data;

  return (
    <>
      <PageHeader
        eyebrow="Hari Ini"
        title="Dasbor Harian"
        description="Penjualan, kas, dan kondisi gudang untuk hari ini."
        actions={(
          <button type="button" className="pss-button pss-button-secondary" onClick={() => void dashboard.refetch()} disabled={dashboard.isFetching}>
            <RefreshCw size={16} aria-hidden="true" /> {dashboard.isFetching ? 'Memuat…' : 'Muat Ulang'}
          </button>
        )}
      />

      {dashboard.isPending && <p className="pss-skeleton-row" aria-label="Memuat dasbor" />}

      {dashboard.isError && (
        <EmptyState
          title="Dasbor belum dapat dimuat"
          description="Angka hari ini sedang tidak dapat diambil. Periksa koneksi lalu muat ulang."
          action={<button type="button" className="pss-button pss-button-primary" onClick={() => void dashboard.refetch()}>Coba Lagi</button>}
        />
      )}

      {data && (
        <>
          <dl className="pss-kpi-grid">
            <Tile state={data.sales} icon={<Banknote />} tone="success" label="Penjualan hari ini">
              {(sales) => rupiah(sales.salesTotal)}
            </Tile>
            <Tile state={data.sales} icon={<Coins />} tone="info" label="Kas konter belum dihitung">
              {(sales) => rupiah(sales.undepositedCash)}
            </Tile>
            <Tile state={data.grossProfit} icon={<TrendingUp />} tone="info" label="Laba kotor hari ini">
              {(profit) => (
                <>
                  {rupiah(profit.today)}
                  {/* Finance's own margin, shown as it was published. It is absent rather than zero
                      when Finance withholds it, so it reads as absent here too. */}
                  {profit.todayMarginPercent === null ? null : <small> &middot; margin {percent(profit.todayMarginPercent)}</small>}
                </>
              )}
            </Tile>
            <Tile state={data.grossProfit} icon={<TrendingUp />} tone="success" label="Laba kotor bulan ini">
              {(profit) => rupiah(profit.monthToDate)}
            </Tile>
            <Tile state={data.stockValue} icon={<Boxes />} tone="info" label="Nilai stok gudang">
              {(value) => (value.totalValue === null ? 'Belum dapat dihitung' : rupiah(value.totalValue))}
            </Tile>
            <Tile state={data.lowStock} icon={<PackageSearch />} tone="warning" label="Stok menipis">
              {(low) => (low.total === 0 ? 'Aman' : `${low.total} jenis`)}
            </Tile>
          </dl>

          <div className="pss-detail-grid">
            <section className="pss-panel" aria-label="Perlu diisi ulang">
              <div className="pss-panel-head">
                <div>
                  <h2>Perlu diisi ulang</h2>
                  {data.lowStock.state === 'OK' && data.lowStock.data.total > 0 && (
                    <p>di bawah {quantity(data.lowStock.data.threshold)} per satuan</p>
                  )}
                </div>
                <div className="pss-panel-actions">
                  <Link className="pss-button pss-button-secondary" href="/kantor/terima">Terima barang</Link>
                </div>
              </div>
              {data.lowStock.state !== 'OK' ? (
                <p>{data.lowStock.state === 'HIDDEN' ? 'Anda tidak punya hak untuk melihat stok yang menipis.' : data.lowStock.reason}</p>
              ) : data.lowStock.data.items.length === 0 ? (
                <p>Tidak ada barang di bawah batas minimum hari ini.</p>
              ) : (
                <table className="pss-data-table">
                  <thead>
                    <tr><th>Barang</th><th>SKU</th><th className="pss-number">Sisa</th></tr>
                  </thead>
                  <tbody>
                    {data.lowStock.data.items.map((item) => (
                      <tr key={item.productId}>
                        <td>{item.name}</td>
                        <td>{item.sku}</td>
                        <td className="pss-number">{quantity(item.qtyOnHand)} {item.uom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <div className="pss-side-stack">
              <Shortcut href="/kantor/penjualan" icon={<Banknote size={18} aria-hidden="true" />} title="Penjualan Konter" detail="Transaksi kasir dan fakturnya." />
              <Shortcut href="/kantor/terima" icon={<Boxes size={18} aria-hidden="true" />} title="Terima Barang" detail="Catat barang yang masuk beserta harga pokoknya." />
              <Shortcut href="/kantor/barang" icon={<PackageSearch size={18} aria-hidden="true" />} title="Barang" detail="Master barang, barcode, dan satuan." />
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** A published percentage in the operator's format. The string is Finance's; only the separators are added here. */
function percent(value: string): string {
  return `${new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))}%`;
}

/**
 * One tile. `state` decides everything it shows, so a tile can never render a blank as though it were
 * a zero: unavailable is its own state, with a registered code behind it and a reason in words, and a
 * hidden tile — one the viewer holds no permission for — is not rendered at all.
 */
function Tile<T>({ state, icon, tone, label, children }: {
  state: DashboardTile<T>;
  icon: ReactNode;
  tone: 'info' | 'success' | 'warning';
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (state.state === 'HIDDEN') {
    // Nothing at all. An empty card with a reason would advertise a figure the viewer may not see and
    // turn a permission into an error (MVP-OD-10).
    return null;
  }
  if (state.state === 'UNAVAILABLE') {
    // The error state shows a dash for the value and the reason underneath, so nothing here passes a
    // value: the reason is the whole message, and it says who owes the number.
    return <KpiCard icon={icon} tone="neutral" label={label} value="" state="error" errorMessage={state.reason} />;
  }
  return <KpiCard icon={icon} tone={tone} label={label} value={children(state.data)} />;
}

function Shortcut({ href, icon, title, detail }: { href: string; icon: ReactNode; title: string; detail: string }) {
  return (
    <Link className="pss-button pss-button-secondary pss-full" href={href} style={{ justifyContent: 'flex-start', height: 'auto', padding: '12px 16px' }}>
      {icon}
      <span style={{ display: 'grid', textAlign: 'left' }}>
        <span style={{ fontWeight: 700 }}>{title}</span>
        <small className="pss-muted" style={{ whiteSpace: 'normal' }}>{detail}</small>
      </span>
    </Link>
  );
}
