'use client';

import type {
  ActivateDraftPriceListResponse, CreateDraftPriceListRequest, PriceListItemEnrichedResponse, PriceListResponse,
  ProductDetail, ProductListResponse, SetPriceListItemRequest,
} from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { KantorProblem } from '../lib/problem';
import { MoneyField } from '../../kasir/components/money-field';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaToday } from '../../kasir/lib/labels';
import { moneyInput, rupiah } from '../../kasir/lib/money';
import { priceListStatusLabel } from '../lib/labels';

const PAGE_SIZE = 25;
/** The scope the counter sells at (POS). It is an opaque string to this domain, not a lookup here. */
const DEFAULT_SCOPE = 'KONTER';

/**
 * Harga Jual — the counter's price list, and how a new version is made (COM-001).
 *
 * **A price change is a new version, never an edit in place.** An ACTIVE list is not editable, so the
 * flow is: copy the live list into a draft, change the prices that moved (and add prices for goods
 * that are not priced yet), then activate the draft. The operator therefore always edits the version
 * that is not yet in force and cannot disturb today's sales by accident.
 *
 * This screen records the number the operator typed. It does not decide what a price *should* be —
 * a margin rule or a rounding rule would be a business rule that belongs somewhere else, and there is
 * none registered.
 */
export function PriceListScreen() {
  const [scope, setScope] = useState(DEFAULT_SCOPE);
  const [openId, setOpenId] = useState<string | null>(null);

  const lists = useQuery({
    queryKey: ['kantor-price-lists', scope],
    queryFn: () => kasirFetch<PriceListResponse>(`/commercial/price-lists?scope=${encodeURIComponent(scope)}&pageSize=${PAGE_SIZE}`),
    retry: false,
  });

  const createDraft = useCommand<CreateDraftPriceListRequest, { priceListId: string }>(
    (input, idempotencyKey) => kasirFetch<{ priceListId: string }>('/commercial/price-lists', {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    {
      onSuccess: async (result) => {
        await lists.refetch();
        setOpenId(result.priceListId);
      },
    },
  );

  const activeId = lists.data?.activePriceListId ?? null;
  // Copying the live list is what makes a price change three lines of work rather than retyping every
  // price in the catalogue — so the button stays disabled until the list has answered, and a click
  // cannot create an empty draft by racing the read. An empty draft is a real state (the very first
  // list) and the helper text below the button says which of the two is about to happen.
  const canPrepare = !lists.isPending && scope.trim() !== '';

  return (
    <BackofficeFrame title="Harga Jual">
      <div className="pos-page-heading">
        <div>
          <h1>Harga Jual</h1>
          <p>Harga per satuan untuk scope yang dipakai di konter.</p>
        </div>
      </div>

      <div className="pos-stack">
        <section className="pos-card">
          <div className="pos-card-title"><h2>Daftar harga</h2></div>

          <form
            className="pos-toolbar pos-filter-row"
            onSubmit={(event) => {
              event.preventDefault();
              createDraft.mutate({
                scope: scope.trim(),
                validFrom: jakartaToday(),
                // Copying the live list is what makes a price change three lines of work rather than
                // retyping every price in the catalogue.
                ...(activeId ? { copyFromPriceListId: activeId } : {}),
              });
            }}
          >
            <label className="pos-field" style={{ margin: 0, flex: 1 }}>
              Scope
              <input value={scope} onChange={(event) => setScope(event.target.value)} required maxLength={64} autoComplete="off" />
            </label>
            <button
              type="submit"
              className="pos-primary"
              disabled={createDraft.isPending || !canPrepare}
            >
              <Plus size={16} aria-hidden="true" /> {createDraft.isPending ? 'Menyiapkan…' : 'Siapkan Versi Baru'}
            </button>
          </form>
          <p className="pos-muted">
            {lists.isPending
              ? 'Memuat harga yang sedang berlaku…'
              : activeId
                ? 'Versi baru menyalin harga versi yang sedang berlaku, sehingga hanya yang berubah perlu diubah.'
                : 'Belum ada daftar harga yang berlaku, jadi versi pertama dimulai kosong.'}
          </p>
          {createDraft.isError && <KantorProblem error={createDraft.error} />}

          {lists.isPending && <LoadingState label="Memuat daftar harga" />}
          {lists.isError && <BackofficeProblem error={lists.error} onRetry={() => void lists.refetch()} />}
          {lists.data && (lists.data.items.length === 0
            ? <EmptyState title="Belum ada daftar harga" description="Siapkan versi pertama, isi harganya, lalu aktifkan." />
            : (
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr><th>Scope</th><th className="pos-number">Versi</th><th>Berlaku sejak</th><th>Keadaan</th></tr>
                  </thead>
                  <tbody>
                    {lists.data.items.map((item) => (
                      <tr key={item.priceListId} className={item.priceListId === (openId ?? activeId) ? 'selected' : undefined}>
                        <td>
                          <button type="button" className="pos-linkish" onClick={() => setOpenId(item.priceListId)}>
                            <strong>{item.scope}</strong>
                          </button>
                          <small>
                            {item.itemCount} harga · {item.priceListId === activeId ? 'yang berlaku sekarang' : `dibuat ${item.createdAt.slice(0, 10)}`}
                          </small>
                        </td>
                        <td className="pos-number">{item.version}</td>
                        <td>{item.validFrom}</td>
                        <td><span className={`pos-status pos-status-${priceListStatusLabel[item.status].tone}`}>{priceListStatusLabel[item.status].label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </section>

        <section className="pos-card">
          {openId ?? activeId
            ? <PriceItems priceListId={openId ?? (activeId as string)} onChanged={() => void lists.refetch()} />
            : (
              <div>
                <div className="pos-card-title"><h2>Harga dalam daftar</h2></div>
                <EmptyState title="Belum ada daftar harga" description="Siapkan versi pertama di kiri, isi harganya, lalu aktifkan." />
              </div>
            )}
        </section>
      </div>
    </BackofficeFrame>
  );
}

/**
 * One version's prices. Only a DRAFT can be changed and only a DRAFT can be activated: the button for
 * each is absent rather than disabled, so an ACTIVE list never offers an edit that would be refused.
 */
function PriceItems({ priceListId, onChanged }: { priceListId: string; onChanged: () => void }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ productId: string; sku: string; name: string; uom: string; unitPrice: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<'unitPrice' | 'product'>('unitPrice');

  const params = new URLSearchParams({ page: '1', pageSize: '100', sort });
  if (query) params.set('q', query);

  const items = useQuery({
    queryKey: ['kantor-price-items', priceListId, params.toString()],
    queryFn: () => kasirFetch<PriceListItemEnrichedResponse>(`/commercial/price-lists/${priceListId}/items?${params}`),
    retry: false,
  });

  const setPrice = useCommand<SetPriceListItemRequest, unknown>(
    (input, idempotencyKey) => kasirFetch(`/commercial/price-lists/${priceListId}/items`, {
      method: 'PUT', body: JSON.stringify(input), idempotencyKey,
    }),
    {
      onSuccess: async () => {
        setEditing(null);
        setAdding(false);
        await items.refetch();
        onChanged();
      },
    },
  );

  const activate = useCommand<void, ActivateDraftPriceListResponse>(
    (_input, idempotencyKey) => kasirFetch<ActivateDraftPriceListResponse>(`/commercial/price-lists/${priceListId}/activation`, {
      method: 'POST', body: '{}', idempotencyKey,
    }),
    { onSuccess: async () => { await items.refetch(); onChanged(); } },
  );

  const draft = items.data?.status === 'DRAFT';

  return (
    <div>
      <div className="pos-card-title">
        <h2>
          Harga dalam daftar
          {items.data && <b>{priceListStatusLabel[items.data.status].label}</b>}
        </h2>
        {draft && !adding && (
          <button type="button" className="pos-outline" onClick={() => setAdding(true)}>
            <Plus size={15} aria-hidden="true" /> Tambah Harga Barang
          </button>
        )}
      </div>

      {items.isPending && <LoadingState label="Memuat harga" />}
      {items.isError && <BackofficeProblem error={items.error} onRetry={() => void items.refetch()} />}
      {items.data && (items.data.items.length === 0
        ? <EmptyState title="Belum ada harga di daftar ini" description="Tambahkan harga per barang, lalu aktifkan daftar ini." />
        : (
          <>
            <form
              className="pos-toolbar pos-filter-row"
              role="search"
              onSubmit={(event) => { event.preventDefault(); setQuery(typed.trim()); }}
            >
              <label className="pos-search">
                <Search size={17} aria-hidden="true" />
                <input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="Cari SKU atau nama barang…"
                  aria-label="Cari barang yang harganya akan diubah"
                />
              </label>
              <span className="pos-filter-label">
                <select value={sort} onChange={(event) => setSort(event.target.value as 'unitPrice' | 'product')} aria-label="Urutkan harga">
                  <option value="unitPrice">Harga tertinggi</option>
                  <option value="product">Sesuai urutan barang</option>
                </select>
              </span>
              <button type="submit" className="pos-outline">Cari</button>
            </form>

            <div className="pos-table-wrap">
              <table className="pos-table">
                <thead><tr><th>SKU</th><th>Barang</th><th>Satuan</th><th className="pos-number">Harga</th><th /></tr></thead>
                <tbody>
                  {items.data.items.map((item) => {
                    const product = item.product;
                    return (
                      <tr key={item.priceListItemId}>
                        <td>{product?.sku ?? '—'}</td>
                        <td><strong>{product?.name ?? 'Barang yang sudah dihapus'}</strong></td>
                        <td>{item.uom}</td>
                        <td className="pos-number">{rupiah(item.unitPrice)}</td>
                        <td>
                          {draft && product && (
                            <button
                              type="button"
                              className="pos-linkish"
                              onClick={() => setEditing({
                                productId: product.productId,
                                sku: product.sku,
                                name: product.name,
                                uom: item.uom,
                                // Digits only: the wire carries a decimal string, and the field
                                // formats it with thousand separators while the operator types.
                                unitPrice: item.unitPrice.replace(/\D/g, ''),
                              })}
                            >
                              Ubah
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ))}

      {draft && adding && <AddPriceForm onDone={() => setAdding(false)} setPrice={setPrice} />}
      {draft && editing && <EditPriceForm editing={editing} onCancel={() => setEditing(null)} setPrice={setPrice} />}

      {/* The activation's answer lives outside the `draft` block on purpose: activation is what makes
          the list stop being a draft, so a message nested inside it would vanish at the exact moment
          the operator needs to read it. */}
      {activate.isError && <KantorProblem error={activate.error} />}
      {activate.isSuccess && (
        <p className="pos-inline-success" role="status">
          Harga versi ini sudah berlaku di konter. Daftar sebelumnya menjadi kedaluwarsa.
        </p>
      )}

      {draft && (
        <div>
          <button type="button" className="pos-primary" onClick={() => activate.mutate()} disabled={activate.isPending}>
            <CheckCircle2 size={17} aria-hidden="true" /> {activate.isPending ? 'Mengaktifkan…' : 'Aktifkan Harga Ini'}
          </button>
          <p className="pos-muted">
            Mengaktifkan daftar ini akan menggantikannya di konter. Daftar tanpa harga tidak dapat diaktifkan.
          </p>
        </div>
      )}
    </div>
  );
}

function EditPriceForm({ editing, onCancel, setPrice }: {
  editing: { productId: string; sku: string; name: string; uom: string; unitPrice: string };
  onCancel: () => void;
  setPrice: ReturnType<typeof useCommand<SetPriceListItemRequest, unknown>>;
}) {
  const [unitPrice, setUnitPrice] = useState(editing.unitPrice);
  return (
    <form
      onSubmit={(event) => { event.preventDefault(); setPrice.mutate({ productId: editing.productId, uom: editing.uom, unitPrice: moneyInput(unitPrice) }); }}
    >
      <h3>Ubah harga {editing.name}</h3>
      {setPrice.isError && <KantorProblem error={setPrice.error} />}
      <p className="pos-muted">{editing.sku} · satuan {editing.uom} · harga sekarang {rupiah(`${moneyInput(editing.unitPrice)}.00`)}</p>
      <MoneyField label="Harga baru" value={unitPrice} onChange={setUnitPrice} autoFocus />
      <PriceSubmit busy={setPrice.isPending} onCancel={onCancel} />
    </form>
  );
}

/**
 * The picker searches `master-data` and offers the product's own units, the same picker as Terima
 * Barang and Penyesuaian Stok.
 *
 * **A price is set before the goods arrive, not after.** Picking from the warehouse's stock list
 * would have made "create a product, price it, receive it" impossible in that order — the product
 * would not be in stock at the moment it needs a price. The unit to price is a fact of the product
 * (its base unit and whatever case units it has), and it is `master-data`'s to answer.
 */
function AddPriceForm({ onDone, setPrice }: {
  onDone: () => void;
  setPrice: ReturnType<typeof useCommand<SetPriceListItemRequest, unknown>>;
}) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<{ productId: string; sku: string; name: string; units: string[]; uom: string } | null>(null);
  const [unitPrice, setUnitPrice] = useState('');

  const search = useQuery({
    queryKey: ['kantor-price-picker', query],
    queryFn: () => kasirFetch<ProductListResponse>(`/master-data/products?q=${encodeURIComponent(query)}&pageSize=8&sort=name`),
    enabled: query !== '',
    retry: false,
  });

  const add = async (productId: string, sku: string, name: string) => {
    setBusy(true);
    setFailed(false);
    try {
      const detail = await kasirFetch<ProductDetail>(`/master-data/products/${productId}`);
      setPicked({
        productId,
        sku,
        name,
        // Base unit first: it is the one a price is almost always quoted in, and it always exists.
        units: [...detail.units].sort((a, b) => Number(b.isBase) - Number(a.isBase)).map((unit) => unit.uom),
        uom: detail.baseUom,
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3>Tambah harga barang</h3>
      {setPrice.isError && <KantorProblem error={setPrice.error} />}
      {failed && <p className="pos-muted" role="status">Barang tidak dapat dipilih. Periksa koneksi lalu coba lagi.</p>}

      {picked === null ? (
        <>
          <form
            className="pos-toolbar pos-filter-row"
            role="search"
            onSubmit={(event) => { event.preventDefault(); setQuery(typed.trim()); }}
          >
            <label className="pos-search">
              <Search size={17} aria-hidden="true" />
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Cari SKU atau nama barang…"
                aria-label="Cari barang yang akan diberi harga"
              />
            </label>
            <button type="submit" className="pos-outline" disabled={typed.trim() === ''}>Cari</button>
          </form>
          {search.isError && <BackofficeProblem error={search.error} onRetry={() => void search.refetch()} />}
          {search.data && (search.data.items.length === 0
            ? <p className="pos-muted">Tidak ada barang yang cocok dengan "{query}".</p>
            : (
              <ul className="pos-katalog-list">
                {search.data.items.map((item) => (
                  <li key={item.productId}>
                    <button
                      type="button"
                      className="pos-linkish"
                      disabled={busy}
                      onClick={() => { void add(item.productId, item.sku, item.name); }}
                    >
                      <strong>{item.name}</strong>
                      <small>{item.sku} · satuan dasar {item.baseUom}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          <button type="button" className="pos-outline" onClick={onDone}>Batal</button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPrice.mutate({ productId: picked.productId, uom: picked.uom, unitPrice: moneyInput(unitPrice) });
          }}
        >
          <p className="pos-muted">{picked.name} · {picked.sku}</p>
          <label className="pos-field">Satuan
            <select value={picked.uom} onChange={(event) => setPicked({ ...picked, uom: event.target.value })}>
              {picked.units.map((uom) => <option key={uom} value={uom}>{uom}</option>)}
            </select>
            <small>
              Harga dihitung per satuan, dan harus diisi pada satuan yang dipindai kasir. Barang yang
              barcode-nya di karton perlu harga karton; harga pcs tidak berlaku saat karton dipindai.
            </small>
          </label>
          <MoneyField label="Harga jual" value={unitPrice} onChange={setUnitPrice} autoFocus />
          <PriceSubmit busy={setPrice.isPending} onCancel={onDone} />
        </form>
      )}
    </div>
  );
}

function PriceSubmit({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="pos-toolbar">
      <button type="submit" className="pos-primary" disabled={busy}>
        <CheckCircle2 size={16} aria-hidden="true" /> {busy ? 'Menyimpan…' : 'Simpan Harga'}
      </button>
      <button type="button" className="pos-outline" onClick={onCancel}>
        <X size={16} aria-hidden="true" /> Batal
      </button>
    </div>
  );
}
