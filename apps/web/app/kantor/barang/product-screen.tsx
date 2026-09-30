'use client';

import type {
  AddProductBarcodeRequest, CreateProductRequest, ProductDetail, ProductListResponse, UpdateProductRequest,
} from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Barcode, Check, Plus, Save, Search } from 'lucide-react';
import { useState } from 'react';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { KantorProblem } from '../lib/problem';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { orderCaptureLabel, productStatusLabel } from '../lib/labels';
import { useKantorSession } from '../warehouse-context';

const PAGE_SIZE = 25;

/**
 * Barang — create, edit, and label a product (MDM-001..003).
 *
 * Three jobs on three screens: a searchable list, the product's own page, and the new-product form.
 * One screen does one job, with one next action visible (DESIGN_SYSTEM §5).
 *
 * **No price and no cost appear here.** A price belongs to Harga and a cost to Stok, so this screen
 * is never an input for a fact another domain owns.
 *
 * A barcode belongs to a *unit*, so the form asks which unit the label represents: a case label is
 * not a piece label, and the counter prices the unit it scans.
 */
export function ProductScreen() {
  const { can } = useKantorSession();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = can('master_data.product.manage');

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: 'name' });
  if (query) params.set('q', query);
  if (status) params.set('status', status);

  const list = useQuery({
    queryKey: ['kantor-products', params.toString()],
    queryFn: () => kasirFetch<ProductListResponse>(`/master-data/products?${params}`),
    retry: false,
  });

  if (creating) return <BackofficeFrame title="Barang"><NewProduct onDone={() => setCreating(false)} /></BackofficeFrame>;
  if (openId) return <BackofficeFrame title="Barang"><ProductPage productId={openId} onBack={() => setOpenId(null)} /></BackofficeFrame>;

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <BackofficeFrame title="Barang">
      <div className="pos-page-heading">
        <div>
          <h1>Barang</h1>
          <p>Master barang, barcode, dan satuan jualnya.</p>
        </div>
        {canManage && (
          <button type="button" className="pos-primary" onClick={() => setCreating(true)}>
            <Plus size={17} aria-hidden="true" /> Barang Baru
          </button>
        )}
      </div>

      <section className="pos-card">
        <form
          className="pos-toolbar pos-filter-row"
          onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(typed.trim()); }}
          role="search"
        >
          <label className="pos-search">
            <Search size={17} aria-hidden="true" />
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Cari SKU atau nama barang…"
              aria-label="Cari SKU atau nama barang"
            />
          </label>
          <span className="pos-filter-label">
            <select
              value={status}
              onChange={(event) => { setStatus(event.target.value); setPage(1); }}
              aria-label="Saring keadaan barang"
            >
              <option value="">Semua keadaan</option>
              <option value="ACTIVE">Aktif</option>
              <option value="DRAFT">Belum diaktifkan</option>
              <option value="INACTIVE">Nonaktif</option>
            </select>
          </span>
          <button type="submit" className="pos-outline">Cari</button>
        </form>

        {list.isPending && <LoadingState label="Memuat daftar barang" />}
        {list.isError && <BackofficeProblem error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && (list.data.items.length === 0
          ? (
            <EmptyState
              title={query ? 'Barang tidak ditemukan' : 'Belum ada barang'}
              description={query
                ? `Tidak ada barang yang cocok dengan "${query}".`
                : 'Buat barang pertama, lalu berilah harga di layar Harga dan terima stoknya di Terima Barang.'}
              {...(canManage && !query ? { action: <button type="button" className="pos-primary" onClick={() => setCreating(true)}>Buat barang pertama</button> } : {})}
            />
          )
          : (
            <>
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>SKU</th><th>Nama barang</th><th>Satuan dasar</th>
                      <th className="pos-number">Satuan jual</th><th>Keadaan</th><th>Dibuat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((item) => {
                      const state = productStatusLabel[item.status];
                      return (
                        <tr key={item.productId}>
                          <td>{item.sku}</td>
                          <td>
                            <button type="button" className="pos-linkish" onClick={() => setOpenId(item.productId)}>
                              <strong>{item.name}</strong>
                            </button>
                            {!item.hasBarcode && <small>Belum ada barcode</small>}
                          </td>
                          <td>{item.baseUom}</td>
                          <td className="pos-number">{item.unitCount}</td>
                          <td><span className={`pos-status pos-status-${state.tone}`}>{state.label}</span></td>
                          <td>{jakartaDateTime(item.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pos-pagination">
                <span className="pos-muted">{list.data.total} barang</span>
                <button type="button" className="pos-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</button>
                <span className="pos-muted">Halaman {page} dari {pages}</span>
                <button type="button" className="pos-outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Berikutnya</button>
              </div>
            </>
          ))}
      </section>
    </BackofficeFrame>
  );
}

/** The new-product form (MDM-001). A SKU is the product's identity and is never edited afterwards. */
function NewProduct({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [baseUom, setBaseUom] = useState('PCS');
  const [orderCapture, setOrderCapture] = useState<'PSS' | 'EXTERNAL'>('PSS');
  const [status, setStatus] = useState<'DRAFT' | 'ACTIVE'>('DRAFT');

  const create = useCommand<CreateProductRequest, ProductDetail>(
    (input, idempotencyKey) => kasirFetch<ProductDetail>('/master-data/products', {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    {
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: ['kantor-products'] });
        onDone();
      },
    },
  );

  return (
    <>
      <div className="pos-page-heading">
        <div>
          <h1>Barang Baru</h1>
          <p>Buat master barang. Harga dan stoknya diisi di layar masing-masing.</p>
        </div>
        <button type="button" className="pos-outline" onClick={onDone}>Batal</button>
      </div>

      <section className="pos-card">
        <form
          onSubmit={(event) => { event.preventDefault(); create.mutate({ sku: sku.trim(), name: name.trim(), baseUom: baseUom.trim(), orderCapture, status }); }}
          noValidate
        >
          {create.isError && <KantorProblem error={create.error} />}

          <label className="pos-field">SKU
            <input value={sku} onChange={(event) => setSku(event.target.value)} required maxLength={64} autoComplete="off" placeholder="BRG-001" />
            <small>Kode unik barang. Tidak dapat diubah setelah barang dibuat.</small>
          </label>

          <label className="pos-field">Nama barang
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} autoComplete="off" placeholder="Mi Instan Goreng 80g" />
          </label>

          <label className="pos-field">Satuan dasar
            <input value={baseUom} onChange={(event) => setBaseUom(event.target.value)} required maxLength={16} autoComplete="off" placeholder="PCS" />
            <small>Satuan terkecil, misalnya PCS, BTL, atau BKS. Satuan lain ditambahkan setelah barang dibuat.</small>
          </label>

          <label className="pos-field">Dicatat di
            <select value={orderCapture} onChange={(event) => setOrderCapture(event.target.value as 'PSS' | 'EXTERNAL')}>
              <option value="PSS">{orderCaptureLabel.PSS}</option>
              <option value="EXTERNAL">{orderCaptureLabel.EXTERNAL}</option>
            </select>
          </label>

          <label className="pos-field">Keadaan
            <select value={status} onChange={(event) => setStatus(event.target.value as 'DRAFT' | 'ACTIVE')}>
              <option value="DRAFT">{productStatusLabel.DRAFT.label}</option>
              <option value="ACTIVE">{productStatusLabel.ACTIVE.label}</option>
            </select>
            <small>Pilih "Belum diaktifkan" bila barang ini belum siap dijual di konter.</small>
          </label>

          <button type="submit" className="pos-primary" disabled={create.isPending}>
            <Check size={17} aria-hidden="true" /> {create.isPending ? 'Menyimpan…' : 'Simpan Barang'}
          </button>
        </form>
      </section>
    </>
  );
}

/** One product: its state on the left, its units and their barcodes on the right. */
function ProductPage({ productId, onBack }: { productId: string; onBack: () => void }) {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['kantor-product', productId],
    queryFn: () => kasirFetch<ProductDetail>(`/master-data/products/${productId}`),
    retry: false,
  });

  const reload = async (message: string) => {
    await client.invalidateQueries({ queryKey: ['kantor-product', productId] });
    await client.invalidateQueries({ queryKey: ['kantor-products'] });
    setNotice(message);
  };

  return (
    <>
      <div className="pos-page-heading">
        <div>
          <h1>{detail.data?.name ?? 'Barang'}</h1>
          <p>{detail.data?.sku}</p>
        </div>
        <button type="button" className="pos-outline" onClick={onBack}>
          <ArrowLeft size={17} aria-hidden="true" /> Kembali ke daftar
        </button>
      </div>

      {detail.isPending && <LoadingState label="Memuat barang" />}
      {detail.isError && <BackofficeProblem error={detail.error} onRetry={() => void detail.refetch()} />}

      {detail.data && (
        <>
          {notice && <p className="pos-inline-success" role="status">{notice}</p>}
          {/* Keyed on the version: a save that bumps it remounts the forms, so a field never keeps a
              value the server has already replaced. */}
          <div className="pos-dashboard-grid" key={detail.data.version}>
            <ProductFacts detail={detail.data} onSaved={reload} />
            <UnitsAndBarcodes detail={detail.data} onSaved={reload} />
          </div>
        </>
      )}
    </>
  );
}

/** Name, base unit, capture source and state. A save carries the version it loaded (STALE_DATA). */
function ProductFacts({ detail, onSaved }: { detail: ProductDetail; onSaved: (message: string) => Promise<void> }) {
  const [name, setName] = useState(detail.name);
  const [baseUom, setBaseUom] = useState(detail.baseUom);
  const [orderCapture, setOrderCapture] = useState<'PSS' | 'EXTERNAL'>(detail.orderCapture);
  const [status, setStatus] = useState<'DRAFT' | 'ACTIVE' | 'INACTIVE'>(detail.status);

  const save = useCommand<UpdateProductRequest, unknown>(
    (input, idempotencyKey) => kasirFetch(`/master-data/products/${detail.productId}`, {
      method: 'PUT', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: () => onSaved('Perubahan barang tersimpan.') },
  );

  return (
    <section className="pos-card">
      <div className="pos-card-title"><h2>Keterangan barang</h2></div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // `expectedVersion` is the version this screen loaded, so two people editing the same
          // product is STALE_DATA for the second rather than a silent overwrite of the first.
          save.mutate({ name: name.trim(), baseUom: baseUom.trim(), orderCapture, status, expectedVersion: detail.version });
        }}
        noValidate
      >
        {save.isError && <KantorProblem error={save.error} />}

        <label className="pos-field">SKU
          <input value={detail.sku} readOnly />
          <small>SKU tidak dapat diubah.</small>
        </label>

        <label className="pos-field">Nama barang
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
        </label>

        <label className="pos-field">Satuan dasar
          <input value={baseUom} onChange={(event) => setBaseUom(event.target.value)} required maxLength={16} />
        </label>

        <label className="pos-field">Dicatat di
          <select value={orderCapture} onChange={(event) => setOrderCapture(event.target.value as 'PSS' | 'EXTERNAL')}>
            <option value="PSS">{orderCaptureLabel.PSS}</option>
            <option value="EXTERNAL">{orderCaptureLabel.EXTERNAL}</option>
          </select>
        </label>

        <label className="pos-field">Keadaan
          <select value={status} onChange={(event) => setStatus(event.target.value as 'DRAFT' | 'ACTIVE' | 'INACTIVE')}>
            <option value="DRAFT">{productStatusLabel.DRAFT.label}</option>
            <option value="ACTIVE">{productStatusLabel.ACTIVE.label}</option>
            <option value="INACTIVE">{productStatusLabel.INACTIVE.label}</option>
          </select>
        </label>

        <button type="submit" className="pos-primary" disabled={save.isPending}>
          <Save size={17} aria-hidden="true" /> {save.isPending ? 'Menyimpan…' : 'Simpan Perubahan'}
        </button>
      </form>
    </section>
  );
}

/** The unit list with the barcode on each, and the two forms that extend them (MDM-003). */
function UnitsAndBarcodes({ detail, onSaved }: { detail: ProductDetail; onSaved: (message: string) => Promise<void> }) {
  const [uom, setUom] = useState('');
  const [factor, setFactor] = useState('');
  const [barcodeUom, setBarcodeUom] = useState('');
  const [barcode, setBarcode] = useState('');

  const addUom = useCommand<{ uom: string; conversionFactor: string }, unknown>(
    (input, idempotencyKey) => kasirFetch(`/master-data/products/${detail.productId}/uoms`, {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: async () => { setUom(''); setFactor(''); await onSaved('Satuan baru ditambahkan.'); } },
  );

  const addBarcode = useCommand<AddProductBarcodeRequest, unknown>(
    (input, idempotencyKey) => kasirFetch(`/master-data/products/${detail.productId}/barcodes`, {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: async () => { setBarcode(''); await onSaved('Barcode ditambahkan.'); } },
  );

  return (
    <section className="pos-card">
      <div className="pos-card-title"><h2>Satuan dan barcode</h2></div>

      <div className="pos-table-wrap">
        <table className="pos-table">
          <thead><tr><th>Satuan</th><th className="pos-number">Isi per {detail.baseUom}</th><th>Barcode</th></tr></thead>
          <tbody>
            {detail.units.map((unit) => (
              <tr key={unit.uom}>
                <td><strong>{unit.uom}</strong>{unit.isBase && <small>Satuan dasar</small>}</td>
                <td className="pos-number">{unit.conversionFactor}</td>
                <td>
                  {unit.barcode
                    ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{unit.barcode}</span>
                    : <span className="pos-muted">Belum ada</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const nextUom = uom.trim().toUpperCase();
          addUom.mutate({ uom: nextUom, conversionFactor: factor.trim() });
        }}
        noValidate
      >
        <h3>Tambah satuan</h3>
        {addUom.isError && <KantorProblem error={addUom.error} />}
        <label className="pos-field">Satuan
          <input value={uom} onChange={(event) => setUom(event.target.value)} required maxLength={16} placeholder="KARTON" autoComplete="off" />
        </label>
        <label className="pos-field">Isi per {detail.baseUom}
          <input value={factor} onChange={(event) => setFactor(event.target.value)} required inputMode="decimal" placeholder="40" autoComplete="off" />
          <small>
            Berapa {detail.baseUom} di dalam satu {uom.trim().toUpperCase() || 'satuan ini'}. Angka ini ditulis sekali dan tidak dapat diubah.
          </small>
        </label>
        <button type="submit" className="pos-outline" disabled={addUom.isPending}>
          <Plus size={16} aria-hidden="true" /> {addUom.isPending ? 'Menyimpan…' : 'Tambah Satuan'}
        </button>
      </form>

      <form
        onSubmit={(event) => { event.preventDefault(); addBarcode.mutate({ uom: barcodeUom, barcode: barcode.trim() }); }}
        noValidate
      >
        <h3>Tambah barcode</h3>
        {addBarcode.isError && <KantorProblem error={addBarcode.error} />}
        <label className="pos-field">Untuk satuan
          <select value={barcodeUom} onChange={(event) => setBarcodeUom(event.target.value)} required>
            <option value="">Pilih satuan…</option>
            {detail.units.map((unit) => <option key={unit.uom} value={unit.uom}>{unit.uom}</option>)}
          </select>
          <small>Barcode karton bukan barcode pcs. Kasir memindai satuan yang diberi label ini.</small>
        </label>
        <label className="pos-field">Kode barcode
          <input value={barcode} onChange={(event) => setBarcode(event.target.value)} required minLength={6} maxLength={64} autoComplete="off" placeholder="8990001000012" />
          <small>Satu barcode untuk satu satuan. Barcode yang sama tidak dapat dipakai barang lain.</small>
        </label>
        <button type="submit" className="pos-outline" disabled={addBarcode.isPending}>
          <Barcode size={16} aria-hidden="true" /> {addBarcode.isPending ? 'Menyimpan…' : 'Tambah Barcode'}
        </button>
      </form>
    </section>
  );
}
