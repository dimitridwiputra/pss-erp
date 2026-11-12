'use client';

import type { GoodsReceiptRequest, GoodsReceiptResponse, ProductDetail, ProductListResponse } from '@pss/contracts';
import { EmptyState, PageHeader, Panel } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { PackagePlus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaToday } from '../../kasir/lib/labels';
import { NO_COST } from '../lib/labels';
import { KantorProblem } from '../lib/problem';
import { threeDecimals } from '../lib/quantity';
import { WarehouseGate } from '../lib/warehouse-gate';
import { WarehousePicker } from '../lib/warehouse-picker';

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
  return (
    <BackofficeFrame title="Terima Barang">
      <PageHeader
        eyebrow="Persediaan"
        title="Terima Barang"
        description="Catat barang yang masuk ke gudang, lengkap dengan harga pokoknya."
        actions={<WarehousePicker />}
      />
      <WarehouseGate>{(warehouseId) => <ReceiveBody warehouseId={warehouseId} />}</WarehouseGate>
    </BackofficeFrame>
  );
}

function ReceiveBody({ warehouseId }: { warehouseId: string }) {
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [businessDate, setBusinessDate] = useState('');
  const [done, setDone] = useState<GoodsReceiptResponse | null>(null);

  const receive = useCommand<GoodsReceiptRequest, GoodsReceiptResponse>(
    (input, idempotencyKey) => kasirFetch<GoodsReceiptResponse>(`/inventory/warehouses/${warehouseId}/goods-receipts`, {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: (result) => { setDone(result); setLines([]); } },
  );

  const incomplete = lines.some((line) => threeDecimals(line.qty) === '');

  return (
    <div className="pss-side-stack">
      {done && (
        <p className="pss-notice-success" role="status">
          {done.movementIds.length} barang diterima dan sudah masuk ke stok gudang.
          {done.unvaluedLineCount > 0
            && ` ${done.unvaluedLineCount} baris tanpa harga pokok — nilainya belum dihitung dan perlu dilengkapi Finance.`}
        </p>
      )}
      {receive.isError && <KantorProblem error={receive.error} />}

      <Panel flush title="Daftar terima" description={lines.length === 0 ? 'Belum ada barang.' : `${lines.length} baris siap diterima.`}>
        <ProductPicker onPick={(line) => setLines((current) => [...current, line])} />

        {lines.length === 0 ? (
          <EmptyState title="Belum ada barang di daftar terima" description="Cari barang di atas, lalu pilih untuk menambahkannya ke daftar terima." />
        ) : (
          <div className="pss-table-scroll">
            <table className="pss-data-table">
              <thead>
                <tr><th>Barang</th><th>Satuan</th><th>Jumlah</th><th>Harga pokok per satuan</th><th /></tr>
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
        )}
      </Panel>

      {lines.length > 0 && (
        <Panel title="Terima barang">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (lines.length === 0 || incomplete) return;
              receive.mutate({
                lines: lines.map((line) => ({
                  productId: line.productId,
                  uom: line.uom,
                  qty: threeDecimals(line.qty),
                  // The key is omitted, not sent as null: an absent cost is how the domain is told this
                  // line arrives unvalued, and null would read as a cost of zero.
                  ...(line.cost === '' ? {} : { unitCost: line.cost }),
                })),
                ...(businessDate ? { businessDate } : {}),
              });
            }}
          >
            <label className="pss-form-field">Tanggal penerimaan
              <input type="date" className="pss-date" value={businessDate} max={jakartaToday()} onChange={(event) => setBusinessDate(event.target.value)} />
              <small className="pss-muted" style={{ whiteSpace: 'normal' }}>Kosongkan untuk memakai hari ini. Isi hanya bila barang datang dengan tanggal dokumen yang berbeda.</small>
            </label>
            <button type="submit" className="pss-button pss-button-primary" disabled={receive.isPending || incomplete}>
              <PackagePlus size={16} aria-hidden="true" /> {receive.isPending ? 'Menerima…' : `Terima ${lines.length} Baris`}
            </button>
          </form>
        </Panel>
      )}
    </div>
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
        className="pss-filter-bar"
        role="search"
        onSubmit={(event: FormEvent) => { event.preventDefault(); setQuery(typed.trim()); }}
      >
        <label className="pss-form-field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
          <span className="pss-visually-hidden">Cari barang yang akan diterima</span>
          <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Cari SKU atau nama barang…" />
        </label>
        <button type="submit" className="pss-button pss-button-secondary" disabled={typed.trim() === ''}>Cari</button>
      </form>

      {failed && <p className="pss-muted" style={{ padding: '0 24px 12px' }} role="status">Barang tidak dapat ditambahkan. Periksa koneksi lalu coba lagi.</p>}
      {search.isError && <KantorProblem error={search.error} action={<button type="button" className="pss-button pss-button-secondary" onClick={() => void search.refetch()}>Coba Lagi</button>} />}
      {search.data && query !== '' && (search.data.items.length === 0
        ? <p className="pss-muted" style={{ padding: '0 24px 12px' }}>Tidak ada barang yang cocok dengan "{query}".</p>
        : (
          <ul className="pss-pick-list">
            {search.data.items.map((item) => (
              <li key={item.productId}>
                <button
                  type="button"
                  className="pss-link-quiet"
                  disabled={busy}
                  onClick={() => { void add(item.productId, item.sku, item.name); }}
                >
                  {item.name}
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
  const sent = threeDecimals(line.qty);
  return (
    <tr>
      <td>{line.name}<small>{line.sku}</small></td>
      <td>
        <label className="pss-visually-hidden" htmlFor={`uom-${line.key}`}>Satuan untuk {line.name}</label>
        <select id={`uom-${line.key}`} value={line.uom} onChange={(event) => onChange({ uom: event.target.value })}>
          {line.units.map((uom) => <option key={uom} value={uom}>{uom}</option>)}
        </select>
      </td>
      <td>
        <label className="pss-visually-hidden" htmlFor={`qty-${line.key}`}>Jumlah {line.name}</label>
        <input
          id={`qty-${line.key}`}
          inputMode="decimal"
          value={line.qty}
          onChange={(event) => onChange({ qty: event.target.value })}
          placeholder="0"
        />
        <small>{sent === '' ? 'Isi jumlah' : `Dicatat sebagai ${sent}`}</small>
      </td>
      <td>
        <label className="pss-visually-hidden" htmlFor={`cost-${line.key}`}>Harga pokok {line.name} per {line.uom}</label>
        <input
          id={`cost-${line.key}`}
          inputMode="numeric"
          value={line.cost}
          onChange={(event) => onChange({ cost: event.target.value.replace(/\D/g, '') })}
          placeholder="Kosongkan bila tidak ada"
        />
        <small>{line.cost === '' ? `Akan diterima tanpa harga pokok (${NO_COST})` : `Harga pokok per ${line.uom}`}</small>
      </td>
      <td>
        <button type="button" className="pss-button pss-button-danger" onClick={onRemove} aria-label={`Hapus ${line.name} dari daftar terima`}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}
