'use client';

import type { StockBalanceListResponse, StockMovementListResponse } from '@pss/contracts';
import { EmptyState, PageHeader, Panel, StatusPill } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { quantity, rupiah } from '../../kasir/lib/money';
import { movementTypeLabel, NO_COST, NO_VALUE } from '../lib/labels';
import { KantorProblem } from '../lib/problem';
import { WarehouseGate } from '../lib/warehouse-gate';
import { WarehousePicker } from '../lib/warehouse-picker';

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
      <PageHeader
        eyebrow="Persediaan"
        title="Stok"
        description="Saldo barang di gudang terpilih beserta nilainya, dan riwayat pergerakan di gudang."
        actions={<WarehousePicker />}
      />
      <WarehouseGate>{(warehouseId) => <StockBody warehouseId={warehouseId} />}</WarehouseGate>
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
      <div className="pss-segmented" role="group" aria-label="Tampilan stok" style={{ marginBottom: 16 }}>
        <button type="button" aria-pressed={view === 'saldo'} className={view === 'saldo' ? 'active' : undefined}
          onClick={() => { setView('saldo'); setPage(1); }}>Saldo</button>
        <button type="button" aria-pressed={view === 'perubahan'} className={view === 'perubahan' ? 'active' : undefined}
          onClick={() => { setView('perubahan'); setPage(1); }}>Riwayat</button>
      </div>

      <Panel flush>
        <form className="pss-filter-bar" onSubmit={search} role="search">
          <label className="pss-form-field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <span className="pss-visually-hidden">{view === 'saldo' ? 'Cari SKU atau nama barang' : 'Cari barang di riwayat'}</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={view === 'saldo' ? 'Cari SKU atau nama barang…' : 'Cari barang di riwayat…'}
            />
          </label>
          {view === 'saldo' ? (
            <>
              <div className="pss-segmented" role="group" aria-label="Saring stok menipis">
                {[
                  { value: '', label: 'Semua jumlah' },
                  { value: '10', label: '10 atau kurang' },
                  { value: '5', label: '5 atau kurang' },
                  { value: '0', label: 'Habis' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={maxQty === option.value}
                    className={maxQty === option.value ? 'active' : undefined}
                    onClick={() => { setMaxQty(option.value); setPage(1); }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <SortSelect value={sort} onChange={(next) => { setSort(next); setPage(1); }} />
            </>
          ) : null}
          <button type="submit" className="pss-button pss-button-secondary">Cari</button>
        </form>

        {view === 'saldo'
          ? <Balances warehouseId={warehouseId} query={query} maxQty={maxQty} sort={sort} page={page} onPage={setPage} />
          : <Ledger warehouseId={warehouseId} query={query} page={page} onPage={setPage} />}
      </Panel>
    </>
  );
}

/**
 * The order is chosen and named, because the ledger cannot sort by name.
 *
 * `core.product` is `master-data`'s table, so this side can only order by what it stores — the product
 * id, which means nothing to a person. Rather than leave the rows in an arbitrary order and say
 * nothing, the screen offers the two orders that do mean something and shows which one is on.
 */
function SortSelect({ value, onChange }: { value: 'qtyOnHand' | 'value'; onChange: (next: 'qtyOnHand' | 'value') => void }) {
  return (
    <div className="pss-segmented" role="group" aria-label="Urutkan saldo">
      <button type="button" aria-pressed={value === 'qtyOnHand'} className={value === 'qtyOnHand' ? 'active' : undefined}
        onClick={() => onChange('qtyOnHand')}>Stok terbanyak</button>
      <button type="button" aria-pressed={value === 'value'} className={value === 'value' ? 'active' : undefined}
        onClick={() => onChange('value')}>Nilai terbesar</button>
    </div>
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
      {balances.isPending && <span className="pss-skeleton-row" aria-label="Memuat saldo stok" />}
      {balances.isError && <ProblemFor error={balances.error} onRetry={() => void balances.refetch()} />}
      {balances.data && (
        <>
          <p className="pss-muted" style={{ whiteSpace: 'normal', padding: '12px 24px 0', margin: 0 }}>
            {[
              `${balances.data.total} jenis barang`,
              balances.data.unvaluedCount > 0 ? `${balances.data.unvaluedCount} belum ada harga pokok` : null,
              balances.data.totalValue !== null
                ? `total nilai ${rupiah(balances.data.totalValue)}`
                : 'total nilai belum dapat dihitung',
            ].filter(Boolean).join(' · ')}
          </p>

          {balances.data.items.length === 0
            ? <EmptyState title="Tidak ada saldo" description="Belum ada barang yang tercatat di gudang ini, atau tidak ada yang cocok dengan saringan." />
            : (
              <>
                <div className="pss-table-scroll">
                  <table className="pss-data-table">
                    <thead>
                      <tr>
                        <th>SKU</th><th>Barang</th><th>Satuan</th>
                        <th className="pss-number">Stok</th><th className="pss-number">Dipesan</th>
                        <th className="pss-number">Harga pokok</th><th className="pss-number">Nilai</th>
                      </tr>
                    </thead>
                    <tbody>
                      {balances.data.items.map((item) => (
                        <tr key={item.productId}>
                          <td>{item.product?.sku ?? '—'}</td>
                          <td>{item.product?.name ?? 'Barang yang sudah dihapus'}</td>
                          <td>{item.uom}</td>
                          <td className="pss-number">{quantity(item.qtyOnHand)}</td>
                          <td className="pss-number">{quantity(item.qtyReserved)}</td>
                          <td className="pss-number">
                            {item.avgUnitCost === null
                              ? <span className="pss-muted" style={{ whiteSpace: 'normal' }}>{NO_COST}</span>
                              : rupiah(item.avgUnitCost)}
                          </td>
                          <td className="pss-number">
                            {item.stockValue === null
                              ? <span className="pss-muted" style={{ whiteSpace: 'normal' }}>{NO_VALUE}</span>
                              : rupiah(item.stockValue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pss-pagination">
                  <span>Halaman {page} dari {pages}</span>
                  <div>
                    <button type="button" className="pss-button pss-button-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Sebelumnya</button>
                    <button type="button" className="pss-button pss-button-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Berikutnya</button>
                  </div>
                </div>
              </>
            )}
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
      {movements.isPending && <span className="pss-skeleton-row" aria-label="Memuat riwayat stok" />}
      {movements.isError && <ProblemFor error={movements.error} onRetry={() => void movements.refetch()} />}
      {movements.data && (movements.data.items.length === 0
        ? <EmptyState title="Belum ada pergerakan" description="Belum ada penerimaan, pengeluaran, atau penyesuaian stok di gudang ini." />
        : (
          <>
            <div className="pss-table-scroll">
              <table className="pss-data-table">
                <thead>
                  <tr>
                    <th>Waktu</th><th>Jenis</th><th>Barang</th>
                    <th className="pss-number">Jumlah</th><th className="pss-number">Harga pokok</th>
                    <th className="pss-number">Nilai</th><th>Alasan</th><th>Sumber</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.data.items.map((item) => {
                    const kind = movementTypeLabel[item.movementType];
                    return (
                      <tr key={item.movementId}>
                        <td>{jakartaDateTime(item.occurredAt)}</td>
                        <td><StatusPill tone={kind.tone} label={kind.label} /></td>
                        <td>{item.product?.name ?? 'Barang yang sudah dihapus'}<small>{item.product?.sku ?? '—'}</small></td>
                        <td className="pss-number">{quantity(item.qty)} {item.uom}</td>
                        <td className="pss-number">
                          {item.unitCost === null ? <span className="pss-muted" style={{ whiteSpace: 'normal' }}>{NO_COST}</span> : rupiah(item.unitCost)}
                        </td>
                        <td className="pss-number">
                          {item.totalCost === null ? <span className="pss-muted" style={{ whiteSpace: 'normal' }}>{NO_VALUE}</span> : rupiah(item.totalCost)}
                        </td>
                        <td>{item.reasonLabel ?? <span className="pss-muted">—</span>}</td>
                        <td>{item.referenceType}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pss-pagination">
              <span>{movements.data.total} baris · halaman {page} dari {pages}</span>
              <div>
                <button type="button" className="pss-button pss-button-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Sebelumnya</button>
                <button type="button" className="pss-button pss-button-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Berikutnya</button>
              </div>
            </div>
          </>
        ))}
    </>
  );
}

/** A refusal on a read, with a way to try again. */
function ProblemFor({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <KantorProblem error={error} action={<button type="button" className="pss-button pss-button-secondary" onClick={onRetry}>Coba Lagi</button>} />;
}
