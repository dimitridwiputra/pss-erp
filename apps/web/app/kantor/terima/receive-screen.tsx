'use client';

import type { GoodsReceiptRequest, GoodsReceiptResponse, ProductDetail, ProductListResponse } from '@pss/contracts';
import { EmptyState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { PackagePlus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { KantorProblem } from '../lib/problem';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaToday } from '../../kasir/lib/labels';
import { NO_COST } from '../lib/labels';
import { threeDecimals } from '../lib/quantity';
import { useKantorSession } from '../warehouse-context';

interface ReceiptLine {
  key: string;
  productId: string;
  sku: string;
  name: string;
  units: string[];
  uom: string;
  qty: string;
  /** Empty means the line is received unvalued, which is a real state and not a mistake. */
  cost: string;
}

/**
 * Terima Barang — a goods receipt posted without a purchase order, with a unit cost (WMS-003).
 *
 * **The cost is asked for, and it may be left empty.** A receipt with no cost is a real state: a
 * physical count has no invoice behind it. The movement is then unvalued, `INVENTORY_RECEIVED`
 * carries `unitCost: null`, and Finance gets an exception to resolve rather than a zero cost to post
 * (MVP_PLAN §5, AGENTS.md §3.7). The screen says so after posting instead of pretending the receipt
 * was complete.
 *
 * A valued receipt onto a balance that already holds unvalued stock does not value that balance
 * either — there is no revaluation in the MVP, so it stays unvalued and stays visible in Stok as
 * "belum ada harga pokok" (MVP-OD-16). The screen does not present that as a completed valuation.
 */
export function ReceiveScreen() {
  const { warehouseId } = useKantorSession();
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [businessDate, setBusinessDate] = useState('');
  const [done, setDone] = useState<GoodsReceiptResponse | null>(null);

  const receive = useCommand<GoodsReceiptRequest, GoodsReceiptResponse>(
    (input, idempotencyKey) => kasirFetch<GoodsReceiptResponse>(`/inventory/warehouses/${warehouseId}/goods-receipts`, {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: (result) => { setDone(result); setLines([]); } },
  );

  if (!warehouseId) {
    return (
      <BackofficeFrame title="Terima Barang">
        <div className="pos-page-heading">
          <div><h1>Terima Barang</h1><p>Catat barang yang masuk ke gudang.</p></div>
        </div>
        <EmptyState
          title="Belum ada gudang yang bisa dipilih"
          description="Akun Anda tidak punya cakupan gudang, jadi barang tidak dapat diterima. Hubungi administrator bila ini tidak sesuai."
        />
      </BackofficeFrame>
    );
  }

  const incomplete = lines.some((line) => threeDecimals(line.qty) === '');

  return (
    <BackofficeFrame title="Terima Barang">
      <div className="pos-page-heading">
        <div>
          <h1>Terima Barang</h1>
          <p>Catat barang yang masuk ke gudang, lengkap dengan harga pokoknya.</p>
        </div>
      </div>

      {done && (
        <p className="pos-inline-success" role="status">
          {done.movementIds.length} barang diterima dan sudah masuk ke stok gudang.
          {done.unvaluedLineCount > 0
            && ` ${done.unvaluedLineCount} baris tanpa harga pokok — nilainya belum dihitung dan perlu dilengkapi Finance.`}
        </p>
      )}
      {receive.isError && <KantorProblem error={receive.error} />}

      <section className="pos-card">
        <ProductPicker onPick={(line) => setLines((current) => [...current, line])} />

        {lines.length === 0
          ? <EmptyState title="Belum ada barang di daftar terima" description="Cari barang di atas, lalu pilih untuk menambahkannya ke daftar terima." />
          : (
            <>
              <div className="pos-table-wrap">
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>Barang</th><th>Satuan</th><th>Jumlah</th>
                      <th>Harga pokok per satuan</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <ReceiptRow
                        key={line.key}
                        line={line}
                        onChange={(patch) => setLines((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)))}
                        onRemove={() => setLines((current) => current.filter((_, at) => at !== index))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (lines.length === 0 || incomplete) return;
                  receive.mutate({
                    lines: lines.map((line) => ({
                      productId: line.productId,
                      uom: line.uom,
                      qty: threeDecimals(line.qty),
                      // The key is omitted, not sent as null: an absent cost is how the domain is told
                      // this line arrives unvalued, and null would read as a cost of zero.
                      ...(line.cost === '' ? {} : { unitCost: line.cost }),
                    })),
                    ...(businessDate ? { businessDate } : {}),
                  });
                }}
              >
                <label className="pos-field">Tanggal penerimaan
                  <input type="date" value={businessDate} max={jakartaToday()} onChange={(event) => setBusinessDate(event.target.value)} />
                  <small>Kosongkan untuk memakai hari ini. Isi hanya bila barang datang dengan tanggal dokumen yang berbeda.</small>
                </label>
                <button type="submit" className="pos-primary" disabled={receive.isPending || incomplete}>
                  <PackagePlus size={17} aria-hidden="true" /> {receive.isPending ? 'Menerima…' : `Terima ${lines.length} Baris`}
                </button>
              </form>
            </>
          )}
      </section>
    </BackofficeFrame>
  );
}

/**
 * Search master data, then pick. The product's own units are read once on pick, so the unit on the
 * line is one the product really has — a unit typed by hand would be refused by the domain only after
 * the operator had filled in the rest of the receipt.
 */
function ProductPicker({ onPick }: { onPick: (line: ReceiptLine) => void }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const search = useQuery({
    queryKey: ['kantor-product-picker', query],
    queryFn: () => kasirFetch<ProductListResponse>(`/master-data/products?q=${encodeURIComponent(query)}&pageSize=8&sort=name`),
    enabled: query !== '',
    retry: false,
  });

  const add = async (productId: string, sku: string, name: string) => {
    setBusy(true);
    setFailed(false);
    try {
      const detail = await kasirFetch<ProductDetail>(`/master-data/products/${productId}`);
      onPick({
        key: crypto.randomUUID(),
        productId,
        sku,
        name,
        // Base unit first: it is the one a receipt almost always means, and it is always valid.
        units: [...detail.units].sort((a, b) => Number(b.isBase) - Number(a.isBase)).map((unit) => unit.uom),
        uom: detail.baseUom,
        qty: '',
        cost: '',
      });
      setTyped('');
      setQuery('');
    } catch {
      // Reported rather than swallowed: a pick that silently did nothing is the worst outcome here,
      // because the operator would go on filling in the rest of the receipt.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
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
            aria-label="Cari barang yang akan diterima"
          />
        </label>
        <button type="submit" className="pos-outline" disabled={typed.trim() === ''}>Cari</button>
      </form>

      {failed && <p className="pos-muted" role="status">Barang tidak dapat ditambahkan. Periksa koneksi lalu coba lagi.</p>}
      {search.isError && <BackofficeProblem error={search.error} onRetry={() => void search.refetch()} />}
      {search.data && query !== '' && (search.data.items.length === 0
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
    </div>
  );
}

/** One receipt line: which unit, how many, and at what cost. */
function ReceiptRow({ line, onChange, onRemove }: {
  line: ReceiptLine;
  onChange: (patch: Partial<ReceiptLine>) => void;
  onRemove: () => void;
}) {
  return (
    <tr>
      <td><strong>{line.name}</strong><small>{line.sku}</small></td>
      <td>
        <label className="pos-visually-hidden" htmlFor={`uom-${line.key}`}>Satuan untuk {line.name}</label>
        <select id={`uom-${line.key}`} value={line.uom} onChange={(event) => onChange({ uom: event.target.value })}>
          {line.units.map((uom) => <option key={uom} value={uom}>{uom}</option>)}
        </select>
      </td>
      <td>
        <label className="pos-visually-hidden" htmlFor={`qty-${line.key}`}>Jumlah {line.name}</label>
        <input
          id={`qty-${line.key}`}
          inputMode="decimal"
          value={line.qty}
          onChange={(event) => onChange({ qty: event.target.value })}
          placeholder="0"
        />
        <small>{threeDecimals(line.qty) === '' ? 'Isi jumlah' : `Dikirim sebagai ${threeDecimals(line.qty)}`}</small>
      </td>
      <td style={{ minWidth: 200 }}>
        <label className="pos-visually-hidden" htmlFor={`cost-${line.key}`}>Harga pokok {line.name} per {line.uom}</label>
        <input
          id={`cost-${line.key}`}
          inputMode="numeric"
          value={line.cost}
          onChange={(event) => onChange({ cost: event.target.value.replace(/\D/g, '') })}
          placeholder="Kosongkan bila tidak ada"
        />
        <small>{line.cost === '' ? `Akan diterima tanpa harga pokok (${NO_COST})` : 'Harga pokok per satuan'}</small>
      </td>
      <td>
        <button type="button" className="pos-danger-link" onClick={onRemove} aria-label={`Hapus ${line.name} dari daftar terima`}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}
