'use client';

import type {
  AddProductBarcodeRequest, CreateProductRequest, ProductDetail, ProductListResponse, UpdateProductRequest,
} from '@pss/contracts';
import type { z } from 'zod';
import { ProductTaxCodeSchema } from '@pss/contracts';

/** The three sales tax codes a product or a customer may carry (TAX-001). */
type ProductTaxCode = z.infer<typeof ProductTaxCodeSchema>;
import { EmptyState, PageHeader, Panel, StatusPill } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Barcode, Plus, Save } from 'lucide-react';
import { useState } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { quantity } from '../../kasir/lib/money';
import { orderCaptureLabel, productStatusLabel, salesTaxCodeLabel, TAX_UNSET } from '../lib/labels';
import { KantorProblem } from '../lib/problem';
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
      <PageHeader
        eyebrow="Data Utama"
        title="Barang"
        description="Master barang, barcode, dan satuan jualnya. Harga diisi di layar Harga, stok di Terima Barang."
        {...(canManage ? { actions: <button type="button" className="pss-button pss-button-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Barang Baru</button> } : {})}
      />

      <Panel flush>
        <form
          className="pss-filter-bar"
          role="search"
          onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(typed.trim()); }}
        >
          <label className="pss-form-field" style={{ flex: 1, minWidth: 220, margin: 0 }}>
            <span className="pss-visually-hidden">Cari SKU atau nama barang</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Cari SKU atau nama barang…"
            />
          </label>
          <div className="pss-segmented" role="group" aria-label="Saring keadaan barang">
            {[
              { value: '', label: 'Semua' },
              { value: 'ACTIVE', label: productStatusLabel.ACTIVE.label },
              { value: 'DRAFT', label: productStatusLabel.DRAFT.label },
              { value: 'INACTIVE', label: productStatusLabel.INACTIVE.label },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={status === option.value}
                className={status === option.value ? 'active' : undefined}
                onClick={() => { setStatus(option.value); setPage(1); }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="submit" className="pss-button pss-button-secondary">Cari</button>
        </form>

        {list.isPending && <span className="pss-skeleton-row" aria-label="Memuat daftar barang" />}
        {list.isError && <ProblemFor error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && (list.data.items.length === 0
          ? (
            <>
              <EmptyState
                title={query ? 'Barang tidak ditemukan' : 'Belum ada barang'}
                description={query
                  ? `Tidak ada barang yang cocok dengan "${query}".`
                  : 'Buat barang pertama, lalu berilah harga di layar Harga dan terima stoknya di Terima Barang.'}
                {...(canManage && !query ? { action: <button type="button" className="pss-button pss-button-primary" onClick={() => setCreating(true)}>Buat barang pertama</button> } : {})}
              />
            </>
          )
          : (
            <>
              <div className="pss-table-scroll">
                <table className="pss-data-table">
                  <thead>
                    <tr>
                      <th>SKU</th><th>Nama barang</th><th>Satuan dasar</th>
                      <th className="pss-number">Satuan jual</th><th>Keadaan</th><th>Dibuat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((item) => {
                      const state = productStatusLabel[item.status];
                      return (
                        <tr key={item.productId}>
                          <td>{item.sku}</td>
                          <td>
                            <button type="button" className="pss-link-quiet" onClick={() => setOpenId(item.productId)}>{item.name}</button>
                            {!item.hasBarcode && <small>Belum ada barcode</small>}
                          </td>
                          <td>{item.baseUom}</td>
                          <td className="pss-number">{item.unitCount}</td>
                          <td><StatusPill tone={state.tone} label={state.label} /></td>
                          <td>{jakartaDateTime(item.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pss-pagination">
                <span>{list.data.total} barang</span>
                <div>
                  <button type="button" className="pss-button pss-button-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</button>
                  <button type="button" className="pss-button pss-button-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Berikutnya</button>
                </div>
              </div>
            </>
          ))}
      </Panel>
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
  /** Empty until the operator chooses. See the Pajak field below for why it is not pre-filled. */
  const [taxCode, setTaxCode] = useState<ProductTaxCode | ''>('');

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
    <BackofficeFrame title="Barang">
      <PageHeader
        eyebrow="Data Utama"
        title="Barang Baru"
        description="Buat master barang. Harga dan stoknya diisi di layar masing-masing."
        actions={<button type="button" className="pss-button pss-button-secondary" onClick={onDone}>Batal</button>}
      />

      <Panel>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              sku: sku.trim(),
              name: name.trim(),
              baseUom: baseUom.trim(),
              orderCapture,
              status,
              // Sent only once a choice is made, so "belum diatur" never happens by accident here.
              ...(taxCode === '' ? {} : { taxCode }),
            });
          }}
          noValidate
        >
          {create.isError && <KantorProblem error={create.error} />}

          <label className="pss-form-field">SKU
            <input value={sku} onChange={(event) => setSku(event.target.value)} required maxLength={64} autoComplete="off" placeholder="BRG-001" />
            <small className="pss-muted" style={{ whiteSpace: 'normal' }}>Kode unik barang. Tidak dapat diubah setelah barang dibuat.</small>
          </label>

          <label className="pss-form-field">Nama barang
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} autoComplete="off" placeholder="Mi Instan Goreng 80g" />
          </label>

          <label className="pss-form-field">Satuan dasar
            <input value={baseUom} onChange={(event) => setBaseUom(event.target.value)} required maxLength={16} autoComplete="off" placeholder="PCS" />
            <small className="pss-muted" style={{ whiteSpace: 'normal' }}>Satuan terkecil, misalnya PCS, BTL, atau BKS. Satuan lain ditambahkan setelah barang dibuat.</small>
          </label>

          <label className="pss-form-field">Dicatat di
            <select value={orderCapture} onChange={(event) => setOrderCapture(event.target.value as 'PSS' | 'EXTERNAL')}>
              <option value="PSS">{orderCaptureLabel.PSS}</option>
              <option value="EXTERNAL">{orderCaptureLabel.EXTERNAL}</option>
            </select>
          </label>

          <label className="pss-form-field">Keadaan
            <select value={status} onChange={(event) => setStatus(event.target.value as 'DRAFT' | 'ACTIVE')}>
              <option value="DRAFT">{productStatusLabel.DRAFT.label}</option>
              <option value="ACTIVE">{productStatusLabel.ACTIVE.label}</option>
            </select>
            <small className="pss-muted" style={{ whiteSpace: 'normal' }}>Pilih "Belum diaktifkan" bila barang ini belum siap dijual di konter.</small>
          </label>

          <label className="pss-form-field">Pajak
            <select
              required
              value={taxCode}
              aria-invalid={taxCode === '' ? true : undefined}
              onChange={(event) => setTaxCode(event.target.value as ProductTaxCode | '')}
            >
              <option value="">Pilih…</option>
              <option value="VAT_OUTPUT">{salesTaxCodeLabel.VAT_OUTPUT}</option>
              <option value="NON_VAT">{salesTaxCodeLabel.NON_VAT}</option>
            </select>
            <small className="pss-muted" style={{ whiteSpace: 'normal' }}>
              {taxCode === ''
                ? 'Pilih satu. PPN hanya dihitung untuk pelanggan yang kena PPN.'
                : taxCode === 'VAT_OUTPUT'
                  ? 'Barang ini dikenai PPN, dihitung di atas harga, untuk pelanggan yang kena PPN.'
                  : 'Barang ini tidak dikenai PPN, siapa pun pembelinya.'}
            </small>
          </label>

          <button
            type="submit"
            className="pss-button pss-button-primary"
            // The form is `noValidate`, so the browser will not enforce `required`; the button does.
            // Pre-selecting a value instead would be deciding a tax treatment on someone's behalf, and
            // an unset one is exactly what makes a PPN sale refuse at the counter (TAX-001, MVP-OD-3).
            disabled={create.isPending || taxCode === ''}
          >
            <Save size={16} aria-hidden="true" /> {create.isPending ? 'Menyimpan…' : 'Simpan Barang'}
          </button>
        </form>
      </Panel>
    </BackofficeFrame>
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
    <BackofficeFrame title="Barang">
      <PageHeader
        eyebrow="Data Utama"
        title={detail.data?.name ?? 'Barang'}
        description={detail.data?.sku}
        actions={<button type="button" className="pss-button pss-button-secondary" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Kembali ke daftar</button>}
      />

      {detail.isPending && <span className="pss-skeleton-row" aria-label="Memuat barang" />}
      {detail.isError && <ProblemFor error={detail.error} onRetry={() => void detail.refetch()} />}

      {detail.data && (
        <>
          {notice && <p className="pss-notice-success" role="status">{notice}</p>}
          {/* Keyed on the version: a save that bumps it remounts the forms, so a field never keeps a
              value the server has already replaced. */}
          <div className="pss-detail-grid" key={detail.data.version}>
            <ProductFacts detail={detail.data} onSaved={reload} />
            <UnitsAndBarcodes detail={detail.data} onSaved={reload} />
          </div>
        </>
      )}
    </BackofficeFrame>
  );
}

/** Name, base unit, capture source and state. A save carries the version it loaded (STALE_DATA). */
function ProductFacts({ detail, onSaved }: { detail: ProductDetail; onSaved: (message: string) => Promise<void> }) {
  const [name, setName] = useState(detail.name);
  const [baseUom, setBaseUom] = useState(detail.baseUom);
  const [orderCapture, setOrderCapture] = useState<'PSS' | 'EXTERNAL'>(detail.orderCapture);
  const [status, setStatus] = useState<'DRAFT' | 'ACTIVE' | 'INACTIVE'>(detail.status);
  /** The stored treatment, or '' for a product that has none. Sending '' would clear nothing, so an
   *  untouched '' is simply omitted and the stored value stands. */
  const [taxCode, setTaxCode] = useState<ProductTaxCode | ''>(detail.taxCode ?? '');

  const save = useCommand<UpdateProductRequest, unknown>(
    (input, idempotencyKey) => kasirFetch(`/master-data/products/${detail.productId}`, {
      method: 'PUT', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: () => onSaved('Perubahan barang tersimpan.') },
  );

  return (
    <Panel title="Keterangan barang">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // `expectedVersion` is the version this screen loaded, so two people editing the same
          // product is STALE_DATA for the second rather than a silent overwrite of the first.
          save.mutate({
            name: name.trim(),
            baseUom: baseUom.trim(),
            orderCapture,
            status,
            // `''` means "I did not touch it", so nothing is sent and the stored code stands. There is
            // deliberately no way to clear a tax code from this screen: removing PPN from a product
            // that has been invoiced is a tax decision (MVP-OD-3), not an edit.
            ...(taxCode === '' ? {} : { taxCode }),
            expectedVersion: detail.version,
          });
        }}
        noValidate
      >
        {save.isError && <KantorProblem error={save.error} />}

        <label className="pss-form-field">SKU
          <input value={detail.sku} readOnly />
          <small className="pss-muted" style={{ whiteSpace: 'normal' }}>SKU tidak dapat diubah.</small>
        </label>

        <label className="pss-form-field">Nama barang
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
        </label>

        <label className="pss-form-field">Satuan dasar
          <input value={baseUom} onChange={(event) => setBaseUom(event.target.value)} required maxLength={16} />
        </label>

        <label className="pss-form-field">Dicatat di
          <select value={orderCapture} onChange={(event) => setOrderCapture(event.target.value as 'PSS' | 'EXTERNAL')}>
            <option value="PSS">{orderCaptureLabel.PSS}</option>
            <option value="EXTERNAL">{orderCaptureLabel.EXTERNAL}</option>
          </select>
        </label>

        <label className="pss-form-field">Pajak
          <select value={taxCode} onChange={(event) => setTaxCode(event.target.value as ProductTaxCode | '')}>
            <option value="">{TAX_UNSET}</option>
            <option value="VAT_OUTPUT">{salesTaxCodeLabel.VAT_OUTPUT}</option>
            <option value="NON_VAT">{salesTaxCodeLabel.NON_VAT}</option>
            {/* Shown when it is already stored, and not offered as a choice. `EXEMPT` and `NON_VAT` are
                both "no PPN" to the resolver but a different statement to a tax authority, and which one
                applies is Finance's call (MVP-OD-3). A select that omitted the stored value would show
                "Belum diatur" for a product that is in fact exempt. */}
            {detail.taxCode === 'EXEMPT' && <option value="EXEMPT">{salesTaxCodeLabel.EXEMPT}</option>}
          </select>
          <small className="pss-muted" style={{ whiteSpace: 'normal' }}>
            {detail.taxCode === null
              ? 'Penjualan barang ini ke pelanggan kena PPN akan ditolak sampai pajaknya diatur.'
              : detail.taxCode === 'EXEMPT'
                ? `Saat ini: ${salesTaxCodeLabel.EXEMPT}, ditetapkan oleh Keuangan dan tidak diubah di layar ini.`
                : `Saat ini: ${salesTaxCodeLabel[detail.taxCode]}.`}
          </small>
        </label>

        <label className="pss-form-field">Keadaan
          <select value={status} onChange={(event) => setStatus(event.target.value as 'DRAFT' | 'ACTIVE' | 'INACTIVE')}>
            <option value="DRAFT">{productStatusLabel.DRAFT.label}</option>
            <option value="ACTIVE">{productStatusLabel.ACTIVE.label}</option>
            <option value="INACTIVE">{productStatusLabel.INACTIVE.label}</option>
          </select>
        </label>

        <button type="submit" className="pss-button pss-button-primary" disabled={save.isPending}>
          <Save size={16} aria-hidden="true" /> {save.isPending ? 'Menyimpan…' : 'Simpan Perubahan'}
        </button>
      </form>
    </Panel>
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
    <div className="pss-side-stack">
      <Panel title="Satuan" flush description={`Satu barcode per satuan. Isi per ${detail.baseUom} ditulis sekali.`}>
        <div className="pss-table-scroll">
          <table className="pss-data-table">
            <thead><tr><th>Satuan</th><th className="pss-number">Isi per {detail.baseUom}</th><th>Barcode</th></tr></thead>
            <tbody>
              {detail.units.map((unit) => (
                <tr key={unit.uom}>
                  <td>{unit.uom}{unit.isBase && <small>Satuan dasar</small>}</td>
                  <td className="pss-number">{quantity(unit.conversionFactor)}</td>
                  <td>
                    {unit.barcode
                      ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{unit.barcode}</span>
                      : <span className="pss-muted">Belum ada</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Tambah satuan">
        <form
          onSubmit={(event) => { event.preventDefault(); addUom.mutate({ uom: uom.trim().toUpperCase(), conversionFactor: factor.trim() }); }}
          noValidate
        >
          {addUom.isError && <KantorProblem error={addUom.error} />}
          <label className="pss-form-field">Satuan
            <input value={uom} onChange={(event) => setUom(event.target.value)} required maxLength={16} placeholder="KARTON" autoComplete="off" />
          </label>
          <label className="pss-form-field">Isi per {detail.baseUom}
            <input value={factor} onChange={(event) => setFactor(event.target.value)} required inputMode="decimal" placeholder="40" autoComplete="off" />
          </label>
          <button type="submit" className="pss-button pss-button-secondary" disabled={addUom.isPending}>
            <Plus size={16} aria-hidden="true" /> {addUom.isPending ? 'Menyimpan…' : 'Tambah Satuan'}
          </button>
        </form>
      </Panel>

      <Panel title="Tambah barcode">
        <form
          onSubmit={(event) => { event.preventDefault(); addBarcode.mutate({ uom: barcodeUom, barcode: barcode.trim() }); }}
          noValidate
        >
          {addBarcode.isError && <KantorProblem error={addBarcode.error} />}
          <label className="pss-form-field">Untuk satuan
            <select value={barcodeUom} onChange={(event) => setBarcodeUom(event.target.value)} required>
              <option value="">Pilih satuan…</option>
              {detail.units.map((unit) => <option key={unit.uom} value={unit.uom}>{unit.uom}</option>)}
            </select>
          </label>
          <label className="pss-form-field">Kode barcode
            <input value={barcode} onChange={(event) => setBarcode(event.target.value)} required minLength={6} maxLength={64} autoComplete="off" placeholder="8990002000018" />
          </label>
          <small className="pss-muted" style={{ display: 'block', marginBottom: 12 }}>
            Barcode karton bukan barcode pcs: kasir memindai satuan yang diberi label ini, dan satuan itulah yang diberi harga.
          </small>
          <button type="submit" className="pss-button pss-button-secondary" disabled={addBarcode.isPending}>
            <Barcode size={16} aria-hidden="true" /> {addBarcode.isPending ? 'Menyimpan…' : 'Tambah Barcode'}
          </button>
        </form>
      </Panel>
    </div>
  );
}

/** A refusal on a read, with the shell's own empty state rather than a form's callout. */
function ProblemFor({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <KantorProblem error={error} action={<button type="button" className="pss-button pss-button-secondary" onClick={onRetry}>Coba Lagi</button>} />;
}

