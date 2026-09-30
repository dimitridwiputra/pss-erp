'use client';

import type {
  ProductDetail, ProductListResponse, StockAdjustmentReasonListResponse, StockAdjustmentRequest, StockAdjustmentResponse,
} from '@pss/contracts';
import { EmptyState, PageHeader, Panel } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { KantorProblem } from '../lib/problem';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaToday } from '../../kasir/lib/labels';
import { threeDecimals } from '../lib/quantity';
import { WarehouseGate } from '../lib/warehouse-gate';
import { WarehousePicker } from '../lib/warehouse-picker';

interface AdjustmentLine {
  key: string;
  productId: string;
  sku: string;
  name: string;
  units: string[];
  uom: string;
  /** Signed: a surplus is positive, a shortage negative. */
  delta: string;
  reasonCode: string;
}

/**
 * Penyesuaian Stok — correct a balance that does not match the goods on the shelf (INV-004..006).
 *
 * **A reason is not optional and is not free text.** The options are the active codes of
 * `inventory.stock_adjustment_reason`, read from the domain, with the Indonesian label the domain
 * stores beside each code. A reason typed free would not be a code Finance can group by, and the
 * PRD's vocabulary is the reason codes themselves (Appendix F.3).
 *
 * **A zero is refused.** Correcting nothing is a mistake, not a correction; the screen disables the
 * button for a zero delta and the domain refuses it independently.
 *
 * `inventory.adjustment.approve` belongs to `BRANCH_MANAGER`, which no demo user holds, so a
 * correction posted here is final (MVP_PLAN §7). The screen says so rather than implying an approval
 * is coming.
 */
export function AdjustmentScreen() {
  return (
    <BackofficeFrame title="Penyesuaian Stok">
      <PageHeader
        eyebrow="Persediaan"
        title="Penyesuaian Stok"
        description="Koreksi saldo barang yang tidak sesuai dengan isi rak. Setiap koreksi perlu alasan."
        actions={<WarehousePicker />}
      />
      <WarehouseGate>{(warehouseId) => <AdjustmentBody warehouseId={warehouseId} />}</WarehouseGate>
    </BackofficeFrame>
  );
}

function AdjustmentBody({ warehouseId }: { warehouseId: string }) {
  const [lines, setLines] = useState<AdjustmentLine[]>([]);
  const [businessDate, setBusinessDate] = useState('');
  const [done, setDone] = useState<StockAdjustmentResponse | null>(null);

  const reasons = useQuery({
    queryKey: ['kantor-adjustment-reasons'],
    queryFn: () => kasirFetch<StockAdjustmentReasonListResponse>('/inventory/stock-adjustment-reasons'),
    retry: false,
  });

  const adjust = useCommand<StockAdjustmentRequest, StockAdjustmentResponse>(
    (input, idempotencyKey) => kasirFetch<StockAdjustmentResponse>(`/inventory/warehouses/${warehouseId}/stock-adjustments`, {
      method: 'POST', body: JSON.stringify(input), idempotencyKey,
    }),
    { onSuccess: (result) => { setDone(result); setLines([]); } },
  );

  // The ledger's own scale: `qty_delta` is `numeric(18,3)` and signed, so "40" reaches the domain as
  // "40.000" and a shortage as "-2.000". A zero delta is refused — correcting nothing is a mistake.
  const deltas = lines.map((line) => threeDecimals(line.delta));
  const payload = lines
    .map((line, index) => ({ productId: line.productId, uom: line.uom, qtyDelta: deltas[index], reasonCode: line.reasonCode }))
    .filter((line): line is { productId: string; uom: string; qtyDelta: string; reasonCode: string } => line.qtyDelta !== undefined);
  const incomplete = lines.length === 0
    || payload.length !== lines.length
    || payload.some((line) => Number(line.qtyDelta) === 0 || line.reasonCode === '');

  return (
    <div className="pss-side-stack">
      {done && (
        <p className="pss-notice-success" role="status">
          {done.movementIds.length} koreksi tersimpan dan sudah tercatat di riwayat stok.
        </p>
      )}
      {adjust.isError && <KantorProblem error={adjust.error} />}

      <Panel flush title="Daftar koreksi" description={lines.length === 0 ? 'Belum ada barang.' : `${lines.length} baris siap disimpan.`}>
        <ProductPicker
          disabled={reasons.isPending || reasons.isError}
          onPick={(line) => setLines((current) => [...current, { ...line, reasonCode: '' }])}
        />

        {reasons.isPending && <span className="pss-skeleton-row" aria-label="Memuat alasan penyesuaian" />}
        {reasons.isError && <KantorProblem error={reasons.error} action={<button type="button" className="pss-button pss-button-secondary" onClick={() => void reasons.refetch()}>Coba Lagi</button>} />}

        {lines.length === 0
          ? <EmptyState title="Belum ada barang untuk dikoreksi" description="Cari barang di atas, lalu pilih untuk menambahkan koreksinya." />
          : (
            <>
              <div className="pss-table-scroll">
                <table className="pss-data-table">
                  <thead>
                    <tr><th>Barang</th><th>Satuan</th><th>Selisih</th><th>Alasan</th><th /></tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={line.key}>
                        <td>{line.name}<small>{line.sku}</small></td>
                        <td>
                          <label className="pss-visually-hidden" htmlFor={`adj-uom-${line.key}`}>Satuan untuk {line.name}</label>
                          <select id={`adj-uom-${line.key}`} value={line.uom} onChange={(event) => patch(lines, setLines, index, { uom: event.target.value })}>
                            {line.units.map((uom) => <option key={uom} value={uom}>{uom}</option>)}
                          </select>
                        </td>
                        <td>
                          <label className="pss-visually-hidden" htmlFor={`adj-delta-${line.key}`}>Selisih {line.name}</label>
                          <input
                            id={`adj-delta-${line.key}`}
                            inputMode="decimal"
                            value={line.delta}
                            onChange={(event) => patch(lines, setLines, index, { delta: event.target.value })}
                            placeholder="mis. -2 untuk kurang"
                          />
                          <small>
                            {deltas[index] === '' || Number(deltas[index]) === 0
                              ? 'Isi selisih, bukan nol'
                              : `${Number(deltas[index]) > 0 ? 'Tambah' : 'Kurang'} ${Math.abs(Number(deltas[index]))} ${line.uom}`}
                          </small>
                        </td>
                        <td>
                          <label className="pss-visually-hidden" htmlFor={`adj-reason-${line.key}`}>Alasan untuk {line.name}</label>
                          <select
                            id={`adj-reason-${line.key}`}
                            value={line.reasonCode}
                            onChange={(event) => patch(lines, setLines, index, { reasonCode: event.target.value })}
                          >
                            <option value="">Pilih alasan…</option>
                            {reasons.data?.items.map((reason) => (
                              <option key={reason.code} value={reason.code}>{reason.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="pss-button pss-button-danger"
                            onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                            aria-label={`Hapus ${line.name} dari daftar koreksi`}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </Panel>

      {lines.length > 0 && (
        <Panel title="Simpan koreksi">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (incomplete) return;
              adjust.mutate({ lines: payload, ...(businessDate ? { businessDate } : {}) });
            }}
          >
            <label className="pss-form-field">Tanggal koreksi
              <input type="date" className="pss-date" value={businessDate} max={jakartaToday()} onChange={(event) => setBusinessDate(event.target.value)} />
              <small className="pss-muted" style={{ whiteSpace: 'normal' }}>Kosongkan untuk memakai hari ini.</small>
            </label>
            <p className="pss-muted" style={{ whiteSpace: 'normal' }}>
              Koreksi yang tersimpan langsung berlaku. Untuk demonstrasi ini tidak ada tahap persetujuan
              berikutnya, jadi periksa jumlah dan alasannya sebelum menyimpan.
            </p>
            <button type="submit" className="pss-button pss-button-primary" disabled={adjust.isPending || incomplete}>
              <ArrowLeftRight size={16} aria-hidden="true" /> {adjust.isPending ? 'Menyimpan…' : `Simpan ${lines.length} Koreksi`}
            </button>
          </form>
        </Panel>
      )}
    </div>
  );
}

function patch(lines: AdjustmentLine[], setLines: (next: AdjustmentLine[]) => void, index: number, changes: Partial<AdjustmentLine>) {
  setLines(lines.map((line, at) => (at === index ? { ...line, ...changes } : line)));
}

function ProductPicker({ onPick, disabled }: { onPick: (line: Omit<AdjustmentLine, 'reasonCode'>) => void; disabled: boolean }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const search = useQuery({
    queryKey: ['kantor-adjust-product-picker', query],
    queryFn: () => kasirFetch<ProductListResponse>(`/master-data/products?q=${encodeURIComponent(query)}&pageSize=8&sort=name`),
    enabled: query !== '' && !disabled,
    retry: false,
  });

  const add = async (productId: string, sku: string, name: string) => {
    setBusy(true);
    try {
      const detail = await kasirFetch<ProductDetail>(`/master-data/products/${productId}`);
      onPick({
        key: crypto.randomUUID(),
        productId,
        sku,
        name,
        units: [...detail.units].sort((a, b) => Number(b.isBase) - Number(a.isBase)).map((unit) => unit.uom),
        uom: detail.baseUom,
        delta: '',
      });
      setTyped('');
      setQuery('');
    } catch {
      // Nothing is added and the list is unchanged, so the operator sees the line never appeared.
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
          <span className="pss-visually-hidden">Cari barang yang akan dikoreksi</span>
          <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Cari SKU atau nama barang…" />
        </label>
        <button type="submit" className="pss-button pss-button-secondary" disabled={typed.trim() === '' || disabled}>Cari</button>
      </form>

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
