'use client';

import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Boxes, Coins, PackageSearch, RefreshCw, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { kantorFetch } from './lib/client';
import { quantity, rupiah } from '../kasir/lib/money';
import type { DashboardTile, KantorDashboard } from '../../lib/kantor/dashboard';

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
      <div className="pos-page-heading">
        <div>
          <h1>Dasbor Harian</h1>
          <p>Penjualan, kas, dan kondisi gudang untuk hari ini.</p>
        </div>
        <button type="button" className="pos-outline" onClick={() => void dashboard.refetch()} disabled={dashboard.isFetching}>
          <RefreshCw size={16} aria-hidden="true" /> {dashboard.isFetching ? 'Memuat…' : 'Muat Ulang'}
        </button>
      </div>

      {dashboard.isPending && <LoadingState label="Memuat dasbor" rows={2} />}

      {dashboard.isError && (
        <EmptyState
          title="Dasbor belum dapat dimuat"
          description="Angka hari ini sedang tidak dapat diambil. Periksa koneksi lalu muat ulang."
          action={<button type="button" className="pos-primary" onClick={() => void dashboard.refetch()}>Coba Lagi</button>}
        />
      )}

      {data && (
        <>
          <dl className="kantor-kpis">
            <Tile state={data.sales} icon={<Banknote />} label="Penjualan hari ini">
              {(sales) => (
                <>
                  <strong>{rupiah(sales.salesTotal)}</strong>
                  <em>{sales.saleCount === 0 ? 'Belum ada transaksi' : `${sales.saleCount} transaksi`}</em>
                </>
              )}
            </Tile>
            <Tile state={data.sales} icon={<Coins />} label="Kas konter belum dihitung">
              {(sales) => (
                <>
                  <strong>{rupiah(sales.undepositedCash)}</strong>
                  <em>{sales.undepositedPaymentCount === 0 ? 'Semua kas sudah dihitung' : `${sales.undepositedPaymentCount} menunggu dihitung`}</em>
                </>
              )}
            </Tile>
            <Tile state={data.grossProfit} icon={<TrendingUp />} label="Laba kotor hari ini">
              {(profit) => (
                <>
                  <strong>{rupiah(profit.today)}</strong>
                  <em>Bulan ini {rupiah(profit.monthToDate)}</em>
                </>
              )}
            </Tile>
            <Tile state={data.stockValue} icon={<Boxes />} label="Nilai stok gudang">
              {(value) => (
                <>
                  <strong>{value.totalValue === null ? 'Belum dapat dihitung' : rupiah(value.totalValue)}</strong>
                  <em>
                    {value.unvaluedCount > 0
                      ? `${value.unvaluedCount} barang belum ada harga pokok`
                      : `${value.balanceCount} jenis barang`}
                  </em>
                </>
              )}
            </Tile>
            <Tile state={data.lowStock} icon={<PackageSearch />} label="Stok menipis">
              {(low) => (
                <>
                  <strong>{low.total === 0 ? 'Aman' : `${low.total} jenis`}</strong>
                  <em>{low.total === 0 ? 'Semua di atas batas minimum' : `di bawah ${quantity(low.threshold)} per satuan`}</em>
                </>
              )}
            </Tile>
          </dl>

          <div className="pos-dashboard-grid">
            <section className="pos-card">
              <div className="pos-card-title">
                <h2>Perlu diisi ulang</h2>
                <Link href="/kantor/terima" className="pos-linkish">Terima barang</Link>
              </div>
              {data.lowStock.state === 'UNAVAILABLE' ? (
                <p className="pos-muted">{data.lowStock.reason}</p>
              ) : data.lowStock.data.items.length === 0 ? (
                <p className="pos-muted">Tidak ada barang di bawah batas minimum hari ini.</p>
              ) : (
                <div className="pos-table-wrap">
                  <table className="pos-table">
                    <thead><tr><th>Barang</th><th>SKU</th><th className="pos-number">Sisa</th></tr></thead>
                    <tbody>
                      {data.lowStock.data.items.map((item) => (
                        <tr key={item.productId}>
                          <td><strong>{item.name}</strong></td>
                          <td>{item.sku}</td>
                          <td className="pos-number">{quantity(item.qtyOnHand)} {item.uom}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="pos-card">
              <div className="pos-card-title"><h2>Lanjut bekerja</h2></div>
              <div>
                <Shortcut href="/kantor/penjualan" icon={<Banknote size={20} aria-hidden="true" />} title="Penjualan Konter" detail="Transaksi kasir dan fakturnya." />
                <Shortcut href="/kantor/terima" icon={<Boxes size={20} aria-hidden="true" />} title="Terima Barang" detail="Catat barang yang masuk beserta harga pokoknya." />
                <Shortcut href="/kantor/barang" icon={<PackageSearch size={20} aria-hidden="true" />} title="Barang" detail="Master barang, barcode, dan satuan." />
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}

/**
 * One tile. `state` decides everything it shows, so a tile can never render a blank as though it were
 * a zero: unavailable is its own state, with words and a reason (AGENTS.md §3.7).
 */
function Tile<T>({ state, icon, label, children }: {
  state: DashboardTile<T>;
  icon: ReactNode;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (state.state === 'UNAVAILABLE') {
    return (
      <div className="pos-kpi pos-card">
        <span className="pos-icon-box" aria-hidden="true">{icon}</span>
        <div>
          <small>{label}</small>
          <strong>Belum tersedia</strong>
          {/* The reason is a sentence in the operator's language, not a headline: the registry's code
              is behind the word, never on the screen. */}
          <em className="pos-kpi-reason">{state.reason}</em>
        </div>
      </div>
    );
  }
  return (
    <div className="pos-kpi pos-card">
      <span className="pos-icon-box" aria-hidden="true">{icon}</span>
      <div>
        <small>{label}</small>
        {children(state.data)}
      </div>
    </div>
  );
}

function Shortcut({ href, icon, title, detail }: { href: string; icon: ReactNode; title: string; detail: string }) {
  return (
    <Link className="pos-action-row" href={href}>
      <span className="pos-icon-box">{icon}</span>
      <span>{title}<small>{detail}</small></span>
    </Link>
  );
}
