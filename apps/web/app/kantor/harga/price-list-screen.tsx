'use client';

import type {
  ActivateDraftPriceListResponse, CreateDraftPriceListRequest, PriceListItemEnrichedResponse, PriceListResponse,
  ProductDetail, ProductListResponse, SetPriceListItemRequest,
} from '@pss/contracts';
import { EmptyState, PageHeader, Panel, StatusPill } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { MoneyField } from '../../kasir/components/money-field';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaToday } from '../../kasir/lib/labels';
import { moneyInput, rupiah } from '../../kasir/lib/money';
import { priceListStatusLabel } from '../lib/labels';
import { KantorProblem } from '../lib/problem';

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
 * This screen records the number the operator typed. It does not decide what a price *should* be — a
 * margin rule or a rounding rule would be a business rule that belongs somewhere else, and there is
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
  const open = openId ?? activeId;

  return (
    <BackofficeFrame title="Harga Jual">
      <PageHeader
        eyebrow="Data Utama"
        title="Harga Jual"
        description="Harga per satuan untuk scope yang dipakai di konter. Harga aktif tidak dapat diubah; perubahannya menjadi versi baru."
      />

      <div className="pss-side-stack">
        <Panel flush title="Daftar harga" description="Satu daftar harga berlaku per scope pada satu waktu.">
          <form
            className="pss-filter-bar"
            onSubmit={(event) => {
              event.preventDefault();
              createDraft.mutate({
                scope: scope.trim(),
                validFrom: jakartaToday(),
                ...(activeId ? { copyFromPriceListId: activeId } : {}),
              });
            }}
          >
            <label className="pss-form-field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
              <span className="pss-visually-hidden">Scope daftar harga</span>
              <input value={scope} onChange={(event) => setScope(event.target.value)} required maxLength={64} autoComplete="off" aria-label="Scope daftar harga" />
            </label>
            <button type="submit" className="pss-button pss-button-primary" disabled={createDraft.isPending || !canPrepare}>
              <Plus size={16} aria-hidden="true" /> {createDraft.isPending ? 'Menyiapkan…' : 'Siapkan Versi Baru'}
            </button>
          </form>

          {lists.isPending && <span className="pss-skeleton-row" aria-label="Memuat daftar harga" />}
          {lists.isError && <ProblemFor error={lists.error} onRetry={() => void lists.refetch()} />}
          {createDraft.isError && <KantorProblem error={createDraft.error} />}

          {lists.data && (
            lists.data.items.length === 0
              ? <EmptyState title="Belum ada daftar harga" description="Siapkan versi pertama, isi harganya, lalu aktifkan." />
              : (
                <>
                  {!lists.isPending && (
                    <p className="pss-muted" style={{ whiteSpace: 'normal', padding: '0 24px 12px' }}>
                      {activeId
                        ? 'Versi baru menyalin harga versi yang sedang berlaku, sehingga hanya yang berubah perlu diubah.'
                        : 'Belum ada daftar harga yang berlaku, jadi versi pertama dimulai kosong.'}
                    </p>
                  )}
                  <div className="pss-table-scroll">
                    <table className="pss-data-table">
                      <thead>
                        <tr><th>Scope</th><th className="pss-number">Versi</th><th>Berlaku sejak</th><th>Keadaan</th></tr>
                      </thead>
                      <tbody>
                        {lists.data.items.map((item) => {
                          const state = priceListStatusLabel[item.status];
                          return (
                            <tr key={item.priceListId}>
                              <td>
                                <button type="button" className="pss-link-quiet" onClick={() => setOpenId(item.priceListId)}>{item.scope}</button>
                                <small>
                                  {[
                                    `${item.itemCount} harga`,
                                    item.priceListId === activeId ? 'yang berlaku sekarang' : `dibuat ${item.createdAt.slice(0, 10)}`,
                                    // Which version the right-hand panel is showing, in words rather than a
                                    // highlight the design system has no class for.
                                    item.priceListId === open ? 'sedang dibuka' : null,
                                  ].filter(Boolean).join(' · ')}
                                </small>
                              </td>
                              <td className="pss-number">{item.version}</td>
                              <td>{item.validFrom}</td>
                              <td><StatusPill tone={state.tone} label={state.label} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )
          )}
        </Panel>

        <div>
          {open
            ? <PriceItems priceListId={open} onChanged={() => void lists.refetch()} />
            : (
              <Panel title="Harga dalam daftar">
                <EmptyState title="Belum ada daftar harga" description="Siapkan versi pertama di kiri, isi harganya, lalu aktifkan." />
              </Panel>
            )}
        </div>
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
  const state = items.data ? priceListStatusLabel[items.data.status] : null;

  return (
    <>
      <Panel
        flush
        title="Harga dalam daftar"
        {...(state ? { description: `Versi ${items.data?.version} · ${state.label}` } : {})}
        {...(draft && !adding
          ? { actions: <button type="button" className="pss-button pss-button-secondary" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" /> Tambah Harga Barang</button> }
          : {})}
      >
        {items.isPending && <span className="pss-skeleton-row" aria-label="Memuat harga" />}
        {items.isError && <ProblemFor error={items.error} onRetry={() => void items.refetch()} />}

        {items.data && (items.data.items.length === 0
          ? <EmptyState title="Belum ada harga di daftar ini" description="Tambahkan harga per barang, lalu aktifkan daftar ini." />
          : (
            <>
              <form
                className="pss-filter-bar"
                role="search"
                onSubmit={(event) => { event.preventDefault(); setQuery(typed.trim()); }}
              >
                <label className="pss-form-field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
                  <span className="pss-visually-hidden">Cari barang yang harganya akan diubah</span>
                  <input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder="Cari SKU atau nama barang…"
                  />
                </label>
                <div className="pss-segmented" role="group" aria-label="Urutkan harga">
                  <button type="button" aria-pressed={sort === 'unitPrice'} className={sort === 'unitPrice' ? 'active' : undefined}
                    onClick={() => setSort('unitPrice')}>Harga tertinggi</button>
                  <button type="button" aria-pressed={sort === 'product'} className={sort === 'product' ? 'active' : undefined}
                    onClick={() => setSort('product')}>Urutan barang</button>
                </div>
                <button type="submit" className="pss-button pss-button-secondary">Cari</button>
              </form>

              <div className="pss-table-scroll">
                <table className="pss-data-table">
                  <thead><tr><th>SKU</th><th>Barang</th><th>Satuan</th><th className="pss-number">Harga</th><th /></tr></thead>
                  <tbody>
                    {items.data.items.map((item) => {
                      const product = item.product;
                      return (
                        <tr key={item.priceListItemId}>
                          <td>{product?.sku ?? '—'}</td>
                          <td>{product?.name ?? 'Barang yang sudah dihapus'}</td>
                          <td>{item.uom}</td>
                          <td className="pss-number">{rupiah(item.unitPrice)}</td>
                          <td className="pss-number">
                            {draft && product && (
                              <button
                                type="button"
                                className="pss-link"
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
      </Panel>

      {/* The activation's answer lives outside the `draft` block on purpose: activation is what makes
          the list stop being a draft, so a message nested inside it would vanish at the exact moment
          the operator needs to read it. */}
      {activate.isError && <KantorProblem error={activate.error} />}
      {activate.isSuccess && (
        <p className="pss-notice-success" role="status">Harga versi ini sudah berlaku di konter. Daftar sebelumnya menjadi kedaluwarsa.</p>
      )}

      {draft && !adding && !editing && (
        <Panel title="Aktifkan daftar ini">
          <p className="pss-muted" style={{ whiteSpace: 'normal', marginTop: 0 }}>
            Mengaktifkan daftar ini akan menggantikannya di konter. Daftar tanpa harga tidak dapat diaktifkan.
          </p>
          <button type="button" className="pss-button pss-button-primary" onClick={() => activate.mutate()} disabled={activate.isPending}>
            <CheckCircle2 size={16} aria-hidden="true" /> {activate.isPending ? 'Mengaktifkan…' : 'Aktifkan Harga Ini'}
          </button>
        </Panel>
      )}

      {draft && adding && <AddPriceForm onDone={() => setAdding(false)} setPrice={setPrice} />}
      {draft && editing && <EditPriceForm editing={editing} onCancel={() => setEditing(null)} setPrice={setPrice} />}
    </>
  );
}

function EditPriceForm({ editing, onCancel, setPrice }: {
  editing: { productId: string; sku: string; name: string; uom: string; unitPrice: string };
  onCancel: () => void;
  setPrice: ReturnType<typeof useCommand<SetPriceListItemRequest, unknown>>;
}) {
  const [unitPrice, setUnitPrice] = useState(editing.unitPrice);
  return (
    <Panel title={`Ubah harga ${editing.name}`} description={`${editing.sku} · satuan ${editing.uom}`}>
      <form
        onSubmit={(event) => { event.preventDefault(); setPrice.mutate({ productId: editing.productId, uom: editing.uom, unitPrice: moneyInput(unitPrice) }); }}
      >
        {setPrice.isError && <KantorProblem error={setPrice.error} />}
        <MoneyField label="Harga baru" value={unitPrice} onChange={setUnitPrice} autoFocus />
        <PriceSubmit busy={setPrice.isPending} onCancel={onCancel} />
      </form>
    </Panel>
  );
}

/**
 * The picker searches `master-data` and offers the product's own units, the same picker as Terima
 * Barang and Penyesuaian Stok.
 *
 * **A price is set before the goods arrive, not after.** Picking from the warehouse's stock list would
 * have made "create a product, price it, receive it" impossible in that order — the product would not
 * be in stock at the moment it needs a price. The unit to price is a fact of the product (its base
 * unit and whatever case units it has), and it is `master-data`'s to answer.
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
    <Panel title="Tambah harga barang">
      {setPrice.isError && <KantorProblem error={setPrice.error} />}
      {failed && <p className="pss-muted" role="status">Barang tidak dapat dipilih. Periksa koneksi lalu coba lagi.</p>}

      {picked === null ? (
        <>
          <form
            className="pss-filter-bar"
            role="search"
            onSubmit={(event) => { event.preventDefault(); setQuery(typed.trim()); }}
          >
            <label className="pss-form-field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
              <span className="pss-visually-hidden">Cari barang yang akan diberi harga</span>
              <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Cari SKU atau nama barang…" />
            </label>
            <button type="submit" className="pss-button pss-button-secondary" disabled={typed.trim() === ''}>Cari</button>
          </form>
          {search.isError && <ProblemFor error={search.error} onRetry={() => void search.refetch()} />}
          {search.data && (search.data.items.length === 0
            ? <p className="pss-muted">Tidak ada barang yang cocok dengan "{query}".</p>
            : (
              <ul className="pss-pick-list">
                {search.data.items.map((item) => (
                  <li key={item.productId}>
                    <button type="button" className="pss-link-quiet" disabled={busy} onClick={() => { void add(item.productId, item.sku, item.name); }}>
                      {item.name}
                      <small>{item.sku} · satuan dasar {item.baseUom}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          <button type="button" className="pss-button pss-button-secondary" onClick={onDone}>Batal</button>
        </>
      ) : (
        <form
          onSubmit={(event) => { event.preventDefault(); setPrice.mutate({ productId: picked.productId, uom: picked.uom, unitPrice: moneyInput(unitPrice) }); }}
        >
          <p className="pss-muted" style={{ whiteSpace: 'normal' }}>{picked.name} · {picked.sku}</p>
          <label className="pss-form-field">Satuan
            <select value={picked.uom} onChange={(event) => setPicked({ ...picked, uom: event.target.value })}>
              {picked.units.map((uom) => <option key={uom} value={uom}>{uom}</option>)}
            </select>
          </label>
          <p className="pss-muted" style={{ whiteSpace: 'normal' }}>
            Harga dihitung per satuan, dan harus diisi pada satuan yang dipindai kasir. Barang yang
            barcode-nya di karton perlu harga karton; harga pcs tidak berlaku saat karton dipindai.
          </p>
          <MoneyField label="Harga jual" value={unitPrice} onChange={setUnitPrice} autoFocus />
          <PriceSubmit busy={setPrice.isPending} onCancel={onDone} />
        </form>
      )}
    </Panel>
  );
}

function PriceSubmit({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="pss-panel-actions">
      <button type="submit" className="pss-button pss-button-primary" disabled={busy}>
        <CheckCircle2 size={16} aria-hidden="true" /> {busy ? 'Menyimpan…' : 'Simpan Harga'}
      </button>
      <button type="button" className="pss-button pss-button-secondary" onClick={onCancel}>
        <X size={16} aria-hidden="true" /> Batal
      </button>
    </div>
  );
}

/** A refusal on a read, with a way to try again rather than a form's callout. */
function ProblemFor({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <KantorProblem error={error} action={<button type="button" className="pss-button pss-button-secondary" onClick={onRetry}>Coba Lagi</button>} />;
}
