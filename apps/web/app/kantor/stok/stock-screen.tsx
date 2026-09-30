'use client';

import type { StockBalanceListResponse, StockMovementListResponse } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { quantity, rupiah } from '../../kasir/lib/money';
import { movementTypeLabel, NO_COST, NO_VALUE } from '../lib/labels';
import { WarehouseGate } from '../lib/warehouse-gate';

const PAGE_SIZE = 25;

/**
 * Stok — what is on hand, what it is worth, and how it got there (INV-001, INV-002).
 *
 * **A missing cost reads as a missing cost.** A balance that has never been valued shows "belum ada
 * harga pokok", never Rp 0: a zero would say the goods are free, and the warehouse total is left
 * blank rather than quietly understating the inventory (MVP-OD-16).
 *
 * The threshold for "stok menipis" is typed by the operator, not fixed here: no configuration key for
 * it exists, so a number the screen chose would be a business rule invented in a component
 * (MVP-OD-17).
 */
export function StockScreen() {
  return (
    <BackofficeFrame title="Stok">
      <div className="pos-page-heading">
        <div>
          <h1>Stok</h1>
          <p>Saldo barang di gudang terpilih beserta nilainya.</p>
        </div>
      </div>
      <section className="pos-card">
        <WarehouseGate>{(warehouseId) => <StockBody warehouseId={warehouseId} />}</WarehouseGate>
      </section>
    </BackofficeFrame>
  );
}

function StockBody({ warehouseId }: { warehouseId: string }) {
  const [view, setView] = useState<'saldo' | 'perubahan'>('saldo');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [maxQty, setMaxQty] = useState('');
  const [sort, setSort] = useState<'qtyOnHand' | 'value'>('qtyOnHand');
  const [page, setPage] = useState(1);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(typed.trim());
  };

  return (
    <>
      <div className="pos-toolbar" style={{ marginTop: 0 }}>
        <button
          type="button"
          className={view === 'saldo' ? 'pos-primary' : 'pos-outline'}
          onClick={() => { setView('saldo'); setPage(1); }}
        >
          Saldo
        </button>
        <button
          type="button"
          className={view === 'perubahan' ? 'pos-primary' : 'pos-outline'}
          onClick={() => { setView('perubahan'); setPage(1); }}
        >
          Riwayat
        </button>
      </div>

      <form className="pos-toolbar pos-filter-row" onSubmit={search} role="search">
        <label className="pos-search">
          <Search size={17} aria-hidden="true" />
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={view === 'saldo' ? 'Cari SKU atau nama barang…' : 'Cari barang di riwayat…'}
            aria-label={view === 'saldo' ? 'Cari SKU atau nama barang' : 'Cari barang di riwayat'}
          />
        </label>
        {view === 'saldo' ? (
          <>
            <span className="pos-filter-label">
              <select value={maxQty} onChange={(event) => { setMaxQty(event.target.value); setPage(1); }} aria-label="Saring stok menipis">
                <option value="">Semua jumlah</option>
                <option value="10">10 atau kurang</option>
                <option value="5">5 atau kurang</option>
                <option value="0">Habis</option>
              </select>
            </span>
            <SortSelect value={sort} onChange={(next) => { setSort(next); setPage(1); }} />
          </>
        ) : (
          <span className="pos-filter-label">
            <select value="occurredAt" onChange={() => setPage(1)} aria-label="Urutkan riwayat">
              <option value="occurredAt">Terbaru lebih dulu</option>
            </select>
          </span>
        )}
        <button type="submit" className="pos-outline">Cari</button>
      </form>

      {view === 'saldo'
        ? <Balances warehouseId={warehouseId} query={query} maxQty={maxQty} sort={sort} page={page} onPage={setPage} />
        : <Ledger warehouseId={warehouseId} query={query} page={page} onPage={setPage} />}
    </>
  );
}

/**
 * The order is chosen and named, because the ledger cannot sort by name.
 *
 * `core.product` is `master-data`'s table, so this side can only order by what it stores — the
 * product id, which means nothing to a person. Rather than leave the rows in an arbitrary order and
 * say nothing, the screen offers the two orders that do mean something and shows which one is on.
 */
function SortSelect({ value, onChange }: { value: 'qtyOnHand' | 'value'; onChange: (next: 'qtyOnHand' | 'value') => void }) {
  return (
    <span className="pos-filter-label">
      <select value={value} onChange={(event) => onChange(event.target.value as 'qtyOnHand' | 'value')} aria-label="Urutkan saldo">
        <option value="qtyOnHand">Stok terbanyak</option>
        <option value="value">Nilai terbesar</option>
      </select>
    </span>
  );
}

function Balances({ warehouseId, query, maxQty, sort, page, onPage }: {
  warehouseId: string;
  query: string;
  maxQty: string;
  sort: 'qtyOnHand' | 'value';
  page: number;
  onPage: (page: number) => void;
}) {
  const params = new URLSearchParams({ warehouseId, page: String(page), pageSize: String(PAGE_SIZE), sort });
  if (query) params.set('q', query);
  if (maxQty) params.set('maxQty', maxQty);

  const balances = useQuery({
    queryKey: ['kantor-stock-balances', params.toString()],
    queryFn: () => kasirFetch<StockBalanceListResponse>(`/inventory/stock-balances?${params}`),
    retry: false,
  });

  const pages = balances.data ? Math.max(1, Math.ceil(balances.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      {balances.isPending && <LoadingState label="Memuat saldo stok" />}
      {balances.isError && <BackofficeProblem error={balances.error} onRetry={() => void balances.refetch()} />}
      {balances.data && (
        <>
          <p className="pos-muted" style={{ marginTop: 0 }}>
            {balances.data.total} jenis barang
            {balances.data.unvaluedCount > 0 && ` · ${balances.data.unvaluedCount} belum ada harga pokok`}
            {balances.data.totalValue !== null && ` · total nilai ${rupiah(balances.data.totalValue)}`}
            {balances.data.totalValue === null && ' · total nilai belum dapat dihitung'}
          </p>

          {balances.data.items.length === 0
            ? <EmptyState title="Tidak ada saldo" description="Belum ada barang yang tercatat di gudang ini, atau tidak ada yang cocok dengan saringan." />
            : (
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>SKU</th><th>Barang</th><th>Satuan</th>
                      <th className="pos-number">Stok</th><th className="pos-number">Dipesan</th>
                      <th className="pos-number">Harga pokok</th><th className="pos-number">Nilai</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.data.items.map((item) => (
                      <tr key={item.productId}>
                        <td>{item.product?.sku ?? '—'}</td>
                        <td><strong>{item.product?.name ?? 'Barang yang sudah dihapus'}</strong></td>
                        <td>{item.uom}</td>
                        <td className="pos-number">{quantity(item.qtyOnHand)}</td>
                        <td className="pos-number">{quantity(item.qtyReserved)}</td>
                        <td className="pos-number">
                          {item.avgUnitCost === null
                            ? <span className="pos-muted">{NO_COST}</span>
                            : rupiah(item.avgUnitCost)}
                        </td>
                        <td className="pos-number">
                          {item.stockValue === null
                            ? <span className="pos-muted">{NO_VALUE}</span>
                            : rupiah(item.stockValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          <div className="pos-pagination">
            <button type="button" className="pos-outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Sebelumnya</button>
            <span className="pos-muted">Halaman {page} dari {pages}</span>
            <button type="button" className="pos-outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Berikutnya</button>
          </div>
        </>
      )}
    </>
  );
}

/** The movement ledger, newest first: what came in, what went out, and what was corrected. */
function Ledger({ warehouseId, query, page, onPage }: {
  warehouseId: string; query: string; page: number; onPage: (page: number) => void;
}) {
  const params = new URLSearchParams({ warehouseId, page: String(page), pageSize: String(PAGE_SIZE), sort: 'occurredAt' });
  if (query) params.set('q', query);

  const movements = useQuery({
    queryKey: ['kantor-stock-movements', params.toString()],
    queryFn: () => kasirFetch<StockMovementListResponse>(`/inventory/stock-movements?${params}`),
    retry: false,
  });

  const pages = movements.data ? Math.max(1, Math.ceil(movements.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      {movements.isPending && <LoadingState label="Memuat riwayat stok" />}
      {movements.isError && <BackofficeProblem error={movements.error} onRetry={() => void movements.refetch()} />}
      {movements.data && (
        <>
          {movements.data.items.length === 0
            ? <EmptyState title="Belum ada pergerakan" description="Belum ada penerimaan, pengeluaran, atau penyesuaian stok di gudang ini." />
            : (
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>Waktu</th><th>Jenis</th><th>Barang</th>
                      <th className="pos-number">Jumlah</th><th className="pos-number">Harga pokok</th>
                      <th className="pos-number">Nilai</th><th>Alasan</th><th>Sumber</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.data.items.map((item) => {
                      const kind = movementTypeLabel[item.movementType];
                      return (
                        <tr key={item.movementId}>
                          <td>{jakartaDateTime(item.occurredAt)}</td>
                          <td><span className={`pos-status pos-status-${kind.tone}`}>{kind.label}</span></td>
                          <td><strong>{item.product?.name ?? 'Barang yang sudah dihapus'}</strong><small>{item.product?.sku ?? '—'}</small></td>
                          <td className="pos-number">{quantity(item.qty)} {item.uom}</td>
                          <td className="pos-number">
                            {item.unitCost === null ? <span className="pos-muted">{NO_COST}</span> : rupiah(item.unitCost)}
                          </td>
                          <td className="pos-number">
                            {item.totalCost === null ? <span className="pos-muted">{NO_VALUE}</span> : rupiah(item.totalCost)}
                          </td>
                          <td>{item.reasonLabel ?? <span className="pos-muted">—</span>}</td>
                          <td>{item.referenceType}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

          <div className="pos-pagination">
            <span className="pos-muted">{movements.data.total} baris</span>
            <button type="button" className="pos-outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Sebelumnya</button>
            <span className="pos-muted">Halaman {page} dari {pages}</span>
            <button type="button" className="pos-outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Berikutnya</button>
          </div>
        </>
      )}
    </>
  );
}
