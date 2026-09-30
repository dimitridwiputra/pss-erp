'use client';

import type {
  AcceptPosTenderResponse, AddPosSaleLineResponse, CheckoutPosSaleResponse, DeclarePosCashHandoverResponse,
  KasirKatalogResponse, KasirShiftSayaResponse, KasirTerminalListResponse, PosReceiptResponse, PosSaleResponse,
} from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Minus, Plus, Printer, ScanLine, Search, ShoppingCart, Trash2, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ProblemNotice } from './components/problem-notice';
import { useCommand } from './hooks/use-command';
import { useOnlineStatus } from './hooks/use-online-status';
import { kasirFetch } from './lib/api-client';
import { MoneyField } from './components/money-field';
import { cashPresets, difference, isAtLeast, quantity, rupiah, sum } from './lib/money';

type Shift = NonNullable<KasirShiftSayaResponse['shift']>;

const post = <T,>(path: string, key: string, body: unknown = {}) =>
  kasirFetch<T>(path, { method: 'POST', idempotencyKey: key, body: JSON.stringify(body) });

/** Registered Appendix F reason codes (area POS); the cashier sees only the words. */
const closeReasons = [
  { code: 'RC-POS-COUNT_SHORT', label: 'Uang kurang' },
  { code: 'RC-POS-COUNT_OVER', label: 'Uang lebih' },
  { code: 'RC-POS-OTHER', label: 'Lainnya' },
] as const;

export function KasirCounter() {
  const shiftSaya = useQuery({ queryKey: ['kasir-shift-saya'], queryFn: () => kasirFetch<KasirShiftSayaResponse>('/kasir/shift-saya') });
  const [handedOver, setHandedOver] = useState<DeclarePosCashHandoverResponse | null>(null);

  if (handedOver) return <CashHandedOver result={handedOver} onDone={() => { setHandedOver(null); void shiftSaya.refetch(); }} />;
  if (shiftSaya.isPending) return <LoadingState label="Memuat shift kasir" />;
  if (shiftSaya.isError) return <ProblemNotice error={shiftSaya.error} action={<button className="pos-outline" type="button" onClick={() => void shiftSaya.refetch()}>Coba Lagi</button>} />;

  const { shift, openSales } = shiftSaya.data;
  if (!shift) return <OpenShift />;
  if (shift.status !== 'OPEN') return <CashHandover shift={shift} onDone={setHandedOver} />;
  return <Selling shift={shift} resumeSale={openSales[0] ?? null} />;
}

function OpenShift() {
  const queryClient = useQueryClient();
  const terminals = useQuery({ queryKey: ['kasir-terminals'], queryFn: () => kasirFetch<KasirTerminalListResponse>('/kasir/terminals') });
  const [terminalId, setTerminalId] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  const open = useCommand(
    (input: { terminalId: string; openingFloat: string }, key) => post('/pos/shifts', key, input),
    { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kasir-shift-saya'] }) },
  );
  const available = terminals.data?.items ?? [];

  return (
    <section className="pos-card pos-kasir-narrow" aria-labelledby="open-shift-title">
      <h2 id="open-shift-title">Buka Shift</h2>
      <p className="pos-muted">Pilih konter, lalu hitung modal laci sebelum mulai berjualan.</p>
      {terminals.isPending && <LoadingState label="Memuat konter" rows={2} />}
      {terminals.isError && <ProblemNotice error={terminals.error} />}
      {terminals.isSuccess && available.length === 0 && (
        <EmptyState title="Belum ada konter untuk Anda" description="Minta admin menambahkan konter di gudang tempat Anda bertugas." />
      )}
      {available.length > 0 && (
        <fieldset className="pos-field">
          <legend>Konter</legend>
          <div className="pos-methods">
            {available.map((terminal) => (
              <button key={terminal.id} type="button" disabled={terminal.inUse} aria-pressed={terminalId === terminal.id}
                className={terminalId === terminal.id ? 'selected' : ''} onClick={() => setTerminalId(terminal.id)}>
                {terminal.name}<small>{terminal.inUse ? 'Sedang dipakai' : terminal.code}</small>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <MoneyField label="Modal laci" value={openingFloat} onChange={setOpeningFloat} />
      <ProblemNotice error={open.error} />
      <button className="pos-primary" type="button" disabled={!terminalId || openingFloat === '' || open.isPending}
        onClick={() => open.mutate({ terminalId, openingFloat })}>
        {open.isPending ? 'Sedang memproses…' : 'Buka Shift'}
      </button>
    </section>
  );
}

type Stage = { name: 'cart' } | { name: 'receipt'; receipt: PosReceiptResponse } | { name: 'close' };

function Selling({ shift, resumeSale }: { shift: Shift; resumeSale: PosSaleResponse | null }) {
  const queryClient = useQueryClient();
  const [saleId, setSaleId] = useState<string | null>(resumeSale?.id ?? null);
  const [stage, setStage] = useState<Stage>({ name: 'cart' });
  const sale = useQuery({
    queryKey: ['pos-sale', saleId], enabled: saleId !== null,
    queryFn: () => kasirFetch<PosSaleResponse>(`/pos/sales/${saleId}`),
  });
  const refreshSale = () => queryClient.invalidateQueries({ queryKey: ['pos-sale', saleId] });
  const refreshShift = () => queryClient.invalidateQueries({ queryKey: ['kasir-shift-saya'] });

  function finishSale() { setSaleId(null); setStage({ name: 'cart' }); void refreshShift(); }

  if (stage.name === 'close') return <CloseShift shift={shift} onCancel={() => setStage({ name: 'cart' })} />;
  if (stage.name === 'receipt') return <Receipt saleId={stage.receipt.saleId} initial={stage.receipt} onNext={finishSale} />;
  // Only a resumed sale waits here. A sale the cart just created keeps the cart mounted, so the
  // add-line command that created it finishes and reports its own outcome.
  if (saleId && sale.isPending && saleId === resumeSale?.id) return <LoadingState label="Memuat transaksi" />;
  if (saleId && sale.isError) return <ProblemNotice error={sale.error} action={<button className="pos-outline" type="button" onClick={finishSale}>Mulai Transaksi Baru</button>} />;

  if (sale.data?.status === 'PENDING_PAYMENT') {
    return <Payment sale={sale.data} onPaid={(receipt) => { setStage({ name: 'receipt', receipt }); void refreshShift(); }} />;
  }
  return (
    <Cart shift={shift} sale={sale.data ?? null} onSaleCreated={setSaleId} onChanged={refreshSale}
      onCheckedOut={refreshSale} onCloseShift={() => setStage({ name: 'close' })} />
  );
}

function Cart({ shift, sale, onSaleCreated, onChanged, onCheckedOut, onCloseShift }: {
  shift: Shift; sale: PosSaleResponse | null; onSaleCreated: (id: string) => void;
  onChanged: () => Promise<void>; onCheckedOut: () => Promise<void>; onCloseShift: () => void;
}) {
  const online = useOnlineStatus();
  const [barcode, setBarcode] = useState('');
  const [search, setSearch] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);
  const lastScan = useRef<{ code: string; at: number } | null>(null);
  useEffect(() => { scanRef.current?.focus(); }, [sale?.lines.length]);

  /** POS-003 idempotency: the same barcode read twice within 500 ms is one scan (a scanner double-read). */
  function scan(code: string) {
    const now = Date.now();
    if (lastScan.current && lastScan.current.code === code && now - lastScan.current.at < 500) { setBarcode(''); return; }
    lastScan.current = { code, at: now };
    addLine.mutate({ barcode: code });
  }

  const katalog = useQuery({
    queryKey: ['kasir-katalog', search.trim()], enabled: search.trim().length >= 2,
    queryFn: () => kasirFetch<KasirKatalogResponse>(`/kasir/products?q=${encodeURIComponent(search.trim())}`),
  });

  const addLine = useCommand(async (input: { barcode: string }, key) => {
    let id = sale?.id;
    if (!id) {
      const created = await post<{ id: string }>('/pos/sales', `${key}:sale`, { shiftId: shift.id });
      id = created.id;
      onSaleCreated(id);
    }
    return post<AddPosSaleLineResponse>(`/pos/sales/${id}/lines`, key, { barcode: input.barcode });
  }, { onSuccess: async () => { setBarcode(''); await onChanged(); } });

  const setQty = useCommand((input: { lineId: string; qty: string }, key) => kasirFetch(`/pos/sales/${sale?.id}/lines/${input.lineId}`, {
    method: 'PATCH', idempotencyKey: key, body: JSON.stringify({ qty: input.qty }),
  }), { onSuccess: onChanged });
  const removeLine = useCommand((input: { lineId: string }, key) => kasirFetch(`/pos/sales/${sale?.id}/lines/${input.lineId}`, {
    method: 'DELETE', idempotencyKey: key,
  }), { onSuccess: onChanged });
  const checkout = useCommand((_input: { saleId: string }, key) => post<CheckoutPosSaleResponse>(`/pos/sales/${sale?.id}/checkout`, key), { onSuccess: onCheckedOut });

  const lines = sale?.lines ?? [];
  const busy = addLine.isPending || setQty.isPending || removeLine.isPending || checkout.isPending;

  return (
    <div className="pos-two-col pos-order-layout">
      <section className="pos-card" aria-labelledby="scan-title">
        <div className="pos-card-title"><h2 id="scan-title">Scan Barang</h2>
          <button className="pos-outline" type="button" onClick={onCloseShift} disabled={lines.length > 0}>Tutup Shift</button>
        </div>
        <form className="pos-toolbar" onSubmit={(event) => { event.preventDefault(); if (barcode.trim()) scan(barcode.trim()); }}>
          <label className="pos-search pos-scan-field"><ScanLine size={22} />
            <input ref={scanRef} aria-label="Scan barang" value={barcode} onChange={(event) => setBarcode(event.target.value)}
              placeholder="Scan atau ketik barcode" autoComplete="off" disabled={!online} />
          </label>
          <button className="pos-primary" type="submit" disabled={!barcode.trim() || busy || !online}>Tambah</button>
        </form>
        <ProblemNotice error={addLine.error} />
        <label className="pos-search pos-katalog-search"><Search size={20} />
          <input aria-label="Cari produk" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nama atau SKU produk" />
        </label>
        {katalog.isFetching && <LoadingState label="Mencari produk" rows={2} />}
        {katalog.isError && <ProblemNotice error={katalog.error} />}
        {katalog.data && (katalog.data.items.length === 0
          ? <p className="pos-empty">Produk tidak ditemukan.</p>
          : <>
            <p className="pos-muted">Scan barcode di kemasan untuk menambahkan barang ke keranjang.</p>
            <ul className="pos-katalog-list">{katalog.data.items.map((item) => <li key={item.productId}><strong>{item.name}</strong><small>{item.sku}</small></li>)}</ul>
          </>)}
      </section>

      <section className="pos-card pos-cart" aria-labelledby="cart-title">
        <div className="pos-card-title"><h2 id="cart-title">Keranjang</h2><span className="pos-muted">{shift.terminalName}</span></div>
        {lines.length === 0
          ? <div className="pos-empty"><ShoppingCart size={28} /><p>Keranjang masih kosong. Scan barang untuk memulai.</p></div>
          : lines.map((line) => (
            <div className="pos-cart-item" key={line.id}>
              <div><strong>{line.name}</strong><small>{line.sku} · {rupiah(line.unitPrice)} / {line.uom}</small>
                <div className="pos-qty">
                  <button type="button" aria-label={`Kurangi ${line.name}`} disabled={busy}
                    onClick={() => (quantity(line.qty) === '1' ? removeLine.mutate({ lineId: line.id }) : setQty.mutate({ lineId: line.id, qty: difference(line.qty, '1') }))}>
                    <Minus size={18} />
                  </button>
                  <span>{quantity(line.qty)} {line.uom}</span>
                  <button type="button" aria-label={`Tambah ${line.name}`} disabled={busy} onClick={() => setQty.mutate({ lineId: line.id, qty: sum(line.qty, '1') })}><Plus size={18} /></button>
                  <button type="button" aria-label={`Hapus ${line.name}`} disabled={busy} onClick={() => removeLine.mutate({ lineId: line.id })}><Trash2 size={18} /></button>
                </div>
              </div>
              <b>{rupiah(line.lineTotal)}</b>
            </div>
          ))}
        <ProblemNotice error={setQty.error ?? removeLine.error ?? checkout.error} />
        <div className="pos-total pos-total-final"><span>Total</span><strong>{rupiah(sale?.total ?? '0')}</strong></div>
        <button className="pos-primary" type="button" disabled={!sale || lines.length === 0 || busy || !online}
          onClick={() => sale && checkout.mutate({ saleId: sale.id })}>
          {checkout.isPending ? 'Sedang memproses…' : <>Bayar <ArrowRight size={18} /></>}
        </button>
      </section>
    </div>
  );
}

function Payment({ sale, onPaid }: { sale: PosSaleResponse; onPaid: (receipt: PosReceiptResponse) => void }) {
  const [received, setReceived] = useState('');
  const enough = isAtLeast(received, sale.total);
  const accept = useCommand(async (input: { cashReceived: string }, key) => {
    await post<AcceptPosTenderResponse>(`/pos/sales/${sale.id}/tenders`, key, { method: 'TUNAI', cashReceived: input.cashReceived });
    return post<PosReceiptResponse>(`/pos/sales/${sale.id}/receipt-prints`, `${key}:receipt`);
  }, { onSuccess: (receipt) => onPaid(receipt) });

  return (
    <section className="pos-card pos-mobile-checkout" aria-labelledby="payment-title">
      <h2 id="payment-title">Terima Uang</h2>
      <small>Total belanja · {sale.invoiceNumber}</small>
      <strong className="pos-mobile-checkout-total">{rupiah(sale.total)}</strong>
      <MoneyField label="Uang diterima" value={received} onChange={setReceived} autoFocus />
      <div className="pos-presets">
        {cashPresets(sale.total).map((value) => <button type="button" key={value} onClick={() => setReceived(value)}>{rupiah(value)}</button>)}
      </div>
      <div className="pos-change"><span>Kembalian</span><strong>{enough ? rupiah(difference(received, sale.total)) : '—'}</strong></div>
      {received !== '' && !enough && <p className="pos-muted">Uang kurang {rupiah(difference(sale.total, received))}.</p>}
      <ProblemNotice error={accept.error} />
      <button className="pos-primary" type="button" disabled={!enough || accept.isPending} onClick={() => accept.mutate({ cashReceived: received })}>
        {accept.isPending ? 'Sedang memproses…' : <><Wallet size={18} /> Terima Uang</>}
      </button>
    </section>
  );
}

function Receipt({ saleId, initial, onNext }: { saleId: string; initial: PosReceiptResponse; onNext: () => void }) {
  const [receipt, setReceipt] = useState(initial);
  const [reprinting, setReprinting] = useState(false);
  const [reason, setReason] = useState('');
  const reprint = useCommand((input: { reprintReason: string }, key) => post<PosReceiptResponse>(`/pos/sales/${saleId}/receipt-prints`, key, input), {
    onSuccess: (next) => { setReceipt(next); setReprinting(false); setReason(''); window.print(); },
  });

  return (
    <div className="pos-kasir-narrow">
      <div className="pos-success-banner"><span className="pos-success-icon"><CheckCircle2 size={30} /></span>
        <div><h2>Pembayaran diterima</h2><p>Berikan kembalian {rupiah(receipt.changeAmount)} dan struk kepada pembeli. Barang diambil di gudang.</p></div>
      </div>
      <article className="pos-card pos-receipt" aria-label="Struk">
        {receipt.isCopy && <p className="pos-receipt-copy">SALINAN {receipt.copyNumber - 1}</p>}
        <h3>{receipt.terminalName}</h3>
        <p className="pos-muted">{receipt.invoiceNumber} · {new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(receipt.paidAt))}</p>
        <ul>{receipt.lines.map((line) => <li key={line.id}><span>{quantity(line.qty)} {line.uom} {line.name}</span><b>{rupiah(line.lineTotal)}</b></li>)}</ul>
        <div className="pos-total"><span>Total</span><strong>{rupiah(receipt.total)}</strong></div>
        <div className="pos-total"><span>Tunai</span><strong>{rupiah(receipt.cashReceived)}</strong></div>
        <div className="pos-total pos-total-final"><span>Kembalian</span><strong>{rupiah(receipt.changeAmount)}</strong></div>
        <p className="pos-muted">Tunjukkan struk ini di gudang untuk mengambil barang.</p>
      </article>
      {reprinting && (
        <div className="pos-card">
          <label className="pos-field">Alasan cetak ulang
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} placeholder="Contoh: kertas macet" />
          </label>
          <ProblemNotice error={reprint.error} />
          <button className="pos-primary" type="button" disabled={!reason.trim() || reprint.isPending} onClick={() => reprint.mutate({ reprintReason: reason.trim() })}>Cetak Salinan</button>
        </div>
      )}
      <div className="pos-footer-actions">
        {receipt.copyNumber === 1
          ? <button className="pos-outline" type="button" onClick={() => window.print()}><Printer size={18} /> Cetak Struk</button>
          : null}
        <button className="pos-outline" type="button" onClick={() => setReprinting(true)} disabled={reprinting}>Cetak Ulang</button>
        <button className="pos-primary" type="button" onClick={onNext}>Transaksi Baru <ArrowRight size={18} /></button>
      </div>
    </div>
  );
}

function CloseShift({ shift, onCancel }: { shift: Shift; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const expected = sum(shift.openingFloat, shift.cashSalesTotal);
  const variance = counted === '' ? null : difference(counted, expected);
  const differs = variance !== null && variance !== '0.00';
  const close = useCommand((input: { countedCash: string; reasonCode?: string }, key) => post(`/pos/shifts/${shift.id}/close`, key, input), {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kasir-shift-saya'] }),
  });

  return (
    <section className="pos-card pos-kasir-narrow" aria-labelledby="close-title">
      <h2 id="close-title">Tutup Shift</h2>
      <dl className="pos-definition">
        <div><dt>Modal laci</dt><dd>{rupiah(shift.openingFloat)}</dd></div>
        <div><dt>Penjualan tunai ({shift.paidSaleCount} transaksi)</dt><dd>{rupiah(shift.cashSalesTotal)}</dd></div>
        <div><dt>Seharusnya di laci</dt><dd><strong>{rupiah(expected)}</strong></dd></div>
      </dl>
      <MoneyField label="Uang di laci setelah dihitung" value={counted} onChange={setCounted} autoFocus />
      {differs && variance && (
        <fieldset className="pos-field">
          <legend>Uang {variance.startsWith('-') ? 'kurang' : 'lebih'} {rupiah(variance.replace(/^-/, ''))} dari seharusnya. Kenapa?</legend>
          <div className="pos-methods">
            {closeReasons.map((reason) => (
              <button key={reason.code} type="button" aria-pressed={reasonCode === reason.code}
                className={reasonCode === reason.code ? 'selected' : ''} onClick={() => setReasonCode(reason.code)}>{reason.label}</button>
            ))}
          </div>
        </fieldset>
      )}
      <ProblemNotice error={close.error} />
      <div className="pos-footer-actions">
        <button className="pos-outline" type="button" onClick={onCancel}>Kembali Berjualan</button>
        <button className="pos-primary" type="button" disabled={counted === '' || (differs && !reasonCode) || close.isPending}
          onClick={() => close.mutate(differs && reasonCode ? { countedCash: counted, reasonCode } : { countedCash: counted })}>
          {close.isPending ? 'Sedang memproses…' : 'Tutup Shift'}
        </button>
      </div>
    </section>
  );
}

function CashHandover({ shift, onDone }: { shift: Shift; onDone: (result: DeclarePosCashHandoverResponse) => void }) {
  const declare = useCommand((_input: { shiftId: string }, key) => post<DeclarePosCashHandoverResponse>(`/pos/shifts/${shift.id}/cash-handover`, key), {
    onSuccess: (result) => onDone(result),
  });
  return (
    <section className="pos-card pos-kasir-narrow" aria-labelledby="handover-title">
      <h2 id="handover-title">Serah Kas</h2>
      {shift.variance && shift.variance !== '0.00' && shift.countedCash ? (
        <>
          {/* MVP-OD-11: the declaration is the recorded sales; the cashier hands over what is actually there. */}
          <p className="pos-instruction">Serahkan semua uang penjualan, {rupiah(difference(shift.countedCash, shift.openingFloat))}, ke Kasir Keuangan. Modal laci {rupiah(shift.openingFloat)} tetap di laci.</p>
          <p className="pos-muted">Penjualan tunai tercatat {rupiah(shift.cashSalesTotal)}; uang {shift.variance.startsWith('-') ? 'kurang' : 'lebih'} {rupiah(shift.variance.replace(/^-/, ''))}. Keuangan mencatat selisihnya saat menghitung.</p>
        </>
      ) : (
        <p className="pos-instruction">Serahkan {rupiah(shift.cashSalesTotal)} ke Kasir Keuangan. Modal laci {rupiah(shift.openingFloat)} tetap di laci.</p>
      )}
      <ProblemNotice error={declare.error} />
      <button className="pos-primary" type="button" disabled={declare.isPending} onClick={() => declare.mutate({ shiftId: shift.id })}>
        {declare.isPending ? 'Sedang memproses…' : 'Serahkan Kas'}
      </button>
    </section>
  );
}

function CashHandedOver({ result, onDone }: { result: DeclarePosCashHandoverResponse; onDone: () => void }) {
  return (
    <section className="pos-card pos-kasir-narrow" aria-labelledby="handed-title">
      <div className="pos-success-banner"><span className="pos-success-icon"><CheckCircle2 size={30} /></span>
        <div><h2 id="handed-title">Kas sudah diserahkan</h2><p>{rupiah(result.declaredAmount)} menunggu dihitung Kasir Keuangan.</p></div>
      </div>
      <button className="pos-primary" type="button" onClick={onDone}>Selesai</button>
    </section>
  );
}
