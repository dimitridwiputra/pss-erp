'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useFinanceData, useFinancePermissions, financeDate, journalLabel, periodLabel, rupiah } from './finance-client';

type Journal = { id: string; number: string; business_date: string; source_type: string;
  source_document_id: string | null; source_document_number: string | null; status: string; period_code: string };
type Exception = { id: string; event_type: string; business_date: string; reason_code: string; status: string };
type Period = { id: string; code: string; status: string };
type Row = { code: string; name: string; debit?: string; credit?: string; net?: string; amount?: string };
type Page<T> = { items: T[]; total: number };

function sourceLink(journal: Journal) {
  if (journal.source_type === 'INVOICE_ISSUED') return '/kantor/penjualan';
  if (journal.source_type === 'INVENTORY_RECEIVED' || journal.source_type === 'INVENTORY_ISSUED'
    || journal.source_type === 'INVENTORY_ADJUSTED') return '/kantor/persediaan';
  if (journal.source_type === 'CASH_CUSTODY_VERIFIED') return '/kantor/setoran-kas';
  return null;
}

function sourceDocument(journal: Journal) {
  const label = journal.source_document_number ?? (journal.source_type === 'MANUAL' ? 'Jurnal manual' : 'Lihat dokumen');
  const href = sourceLink(journal);
  return href ? <Link href={href}>{label}</Link> : label;
}

function economicEventLabel(eventType: string) {
  return ({ INVENTORY_RECEIVED: 'Penerimaan barang', INVENTORY_ISSUED: 'Barang keluar',
    INVENTORY_ADJUSTED: 'Penyesuaian stok', INVOICE_ISSUED: 'Faktur penjualan',
    PAYMENT_RECEIVED: 'Pembayaran', PAYMENT_REVERSED: 'Pembayaran dibalik',
    CASH_CUSTODY_VERIFIED: 'Setoran kas' } as Record<string, string>)[eventType] ?? 'Transaksi lain';
}

function State({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <p role="status" className="finance-message">Data keuangan sedang dimuat…</p>;
  if (error) return <p role="alert" className="finance-message finance-error">{error}</p>;
  return null;
}

export function FinanceHome() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const periods = useFinanceData<Period[]>('finance/periods');
  const exceptions = useFinanceData<Page<Exception>>('finance/posting-exceptions?limit=1&offset=0');
  const journals = useFinanceData<Page<Journal>>('finance/journals?limit=10&offset=0');
  const summary = useFinanceData<{ grossProfitToday: string; grossProfitMonthToDate: string }>(`finance/summary?businessDate=${today}`);
  const current = periods.data?.find((period) => period.code === today.slice(0, 7));
  return <>
    <p className="eyebrow">HARI INI</p><h1>Beranda Keuangan</h1>
    <p className="finance-intro">Periksa periode, jurnal, dan transaksi yang perlu ditindaklanjuti.</p>
    <State loading={periods.loading || exceptions.loading || journals.loading || summary.loading}
      error={periods.error || exceptions.error || journals.error || summary.error} />
    <div className="finance-cards">
      <div className="finance-card"><p>Periode {today.slice(0, 7)}</p><strong>{current ? periodLabel(current.status) : 'Belum tersedia'}</strong></div>
      <div className="finance-card"><p>Pengecualian posting</p><strong>{exceptions.data?.total ?? '—'}</strong></div>
      <div className="finance-card"><p>Laba kotor hari ini</p><strong>{summary.data ? rupiah(summary.data.grossProfitToday) : '—'}</strong></div>
      <div className="finance-card"><p>Laba kotor bulan ini</p><strong>{summary.data ? rupiah(summary.data.grossProfitMonthToDate) : '—'}</strong></div>
    </div>
    <section className="finance-panel"><h2>Jurnal terbaru</h2>
      {!journals.data?.items.length ? <p>Belum ada jurnal untuk ditampilkan.</p> :
        <table className="finance-table"><thead><tr><th>Nomor</th><th>Tanggal</th><th>Status</th><th>Aksi</th></tr></thead>
          <tbody>{journals.data.items.map((journal) => <tr key={journal.id}><td>{journal.number}</td><td>{financeDate(journal.business_date)}</td>
            <td>{journalLabel(journal.status)}</td><td><Link href={`/keuangan/jurnal/${journal.id}`}>Lihat jurnal</Link></td></tr>)}</tbody></table>}
    </section>
  </>;
}

export function JournalList() {
  const result = useFinanceData<Page<Journal>>('finance/journals?limit=50&offset=0');
  return <><h1>Jurnal</h1><p className="finance-intro">Telusuri jurnal dan dokumen sumbernya.</p>
    <State loading={result.loading} error={result.error} />
    <section className="finance-panel">
      {!result.data?.items.length ? <p>Belum ada jurnal.</p> : <table className="finance-table"><thead><tr>
        <th>Nomor</th><th>Tanggal</th><th>Dokumen sumber</th><th>Status</th><th>Aksi</th>
      </tr></thead><tbody>{result.data.items.map((journal) => <tr key={journal.id}>
        <td>{journal.number}</td><td>{financeDate(journal.business_date)}</td>
        <td>{sourceDocument(journal)}</td><td>{journalLabel(journal.status)}</td>
        <td><Link href={`/keuangan/jurnal/${journal.id}`}>Lihat detail</Link></td>
      </tr>)}</tbody></table>}
    </section></>;
}

export function JournalDetail({ id }: { id: string }) {
  const result = useFinanceData<Journal & { lines: Array<{ line_number: number; account_code: string;
    account_name: string; debit: string; credit: string; memo: string | null }> }>(`finance/journals/${id}`);
  const permissions = useFinancePermissions();
  const [reversalReason, setReversalReason] = useState('');
  const [reversalMessage, setReversalMessage] = useState('');
  const canReverse = result.data?.status === 'POSTED'
    && ['MANUAL','ADJUSTMENT','OPENING'].includes(result.data.source_type)
    && permissions.includes('finance.journal.reverse.request');
  async function requestReversal() {
    if (!reversalReason.trim()) return;
    const response = await fetch(`/api/bff/finance/finance/journals/${id}/reversal-requests`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ reason: reversalReason.trim() }),
    });
    setReversalMessage(response.ok
      ? 'Pembalikan menunggu persetujuan petugas lain.'
      : 'Pembalikan belum dapat diajukan. Periksa periode dan alasan, lalu coba lagi.');
  }
  return <><Link href="/keuangan/jurnal">← Kembali ke jurnal</Link><h1>Detail Jurnal</h1>
    <State loading={result.loading} error={result.error} />
    {result.data && <section className="finance-panel"><h2>{result.data.number}</h2>
      <p>{financeDate(result.data.business_date)} · {journalLabel(result.data.status)}</p>
      <p>Dokumen sumber: {sourceDocument(result.data)}</p>
      <table className="finance-table"><thead><tr><th>Akun</th><th>Catatan</th><th className="number">Debit</th><th className="number">Kredit</th></tr></thead>
        <tbody>{result.data.lines.map((line) => <tr key={line.line_number}><td>{line.account_code} · {line.account_name}</td>
          <td>{line.memo}</td><td className="number">{rupiah(line.debit)}</td><td className="number">{rupiah(line.credit)}</td></tr>)}</tbody></table>
      {canReverse && <div className="finance-form"><label>Alasan pembalikan
        <textarea value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} required /></label>
        <button className="finance-button" type="button" disabled={!reversalReason.trim()}
          onClick={() => void requestReversal()}>Ajukan pembalikan</button></div>}
      {reversalMessage && <p role="status" className="finance-message">{reversalMessage}</p>}
    </section>}
  </>;
}

export function TrialBalance() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const result = useFinanceData<{ lines: Row[]; totalDebit: string; totalCredit: string; balanced: boolean }>(`finance/trial-balance?through=${today}`);
  return <><h1>Neraca Saldo</h1><p className="finance-intro">Saldo sampai {today}. Angka berasal dari jurnal yang sudah dibukukan.</p>
    <State loading={result.loading} error={result.error} />
    {result.data && <section className="finance-panel"><table className="finance-table"><thead><tr><th>Akun</th><th className="number">Debit</th><th className="number">Kredit</th></tr></thead>
      <tbody>{result.data.lines.map((row) => <tr key={row.code}><td>{row.code} · {row.name}</td><td className="number">{rupiah(row.debit ?? '0')}</td><td className="number">{rupiah(row.credit ?? '0')}</td></tr>)}
      <tr><th>Jumlah</th><th className="number">{rupiah(result.data.totalDebit)}</th><th className="number">{rupiah(result.data.totalCredit)}</th></tr></tbody></table>
      {!result.data.balanced && <p className="finance-message finance-error">Neraca saldo belum seimbang. Periksa jurnal.</p>}
    </section>}
  </>;
}

export function ProfitAndLoss() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const result = useFinanceData<{ lines: Row[]; revenue: string; costOfGoods: string; grossProfit: string; netProfit: string }>(
    `finance/profit-and-loss?from=${today.slice(0, 7)}-01&to=${today}`);
  return <><h1>Laba Rugi</h1><p className="finance-intro">Periode {today.slice(0, 7)} · Belum final sampai periode ditutup.</p>
    <State loading={result.loading} error={result.error} />
    {result.data && <><div className="finance-cards"><div className="finance-card"><p>Penjualan</p><strong>{rupiah(result.data.revenue)}</strong></div>
      <div className="finance-card"><p>Laba kotor</p><strong>{rupiah(result.data.grossProfit)}</strong></div>
      <div className="finance-card"><p>Laba bersih</p><strong>{rupiah(result.data.netProfit)}</strong></div></div>
      <section className="finance-panel"><table className="finance-table"><thead><tr><th>Akun</th><th className="number">Nilai</th></tr></thead>
        <tbody>{result.data.lines.map((row) => <tr key={row.code}><td>{row.code} · {row.name}</td><td className="number">{rupiah(row.net ?? '0')}</td></tr>)}</tbody></table></section></>}
  </>;
}

export function BalanceSheet() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const result = useFinanceData<{ assets: Row[]; liabilities: Row[]; equity: Row[]; currentPeriodProfit: string;
    totalAssets: string; totalLiabilities: string; totalEquity: string; difference: string }>(`finance/balance-sheet?through=${today}`);
  return <><h1>Neraca</h1><p className="finance-intro">Posisi sampai {today} · Laba periode berjalan ditampilkan di ekuitas.</p>
    <State loading={result.loading} error={result.error} />
    {result.data && <section className="finance-panel"><table className="finance-table"><thead><tr><th>Pos</th><th className="number">Nilai</th></tr></thead><tbody>
      <tr><th colSpan={2}>Aset</th></tr>{result.data.assets.map((row) => <tr key={row.code}><td>{row.name}</td><td className="number">{rupiah(row.amount ?? '0')}</td></tr>)}
      <tr><th>Jumlah aset</th><th className="number">{rupiah(result.data.totalAssets)}</th></tr>
      <tr><th colSpan={2}>Liabilitas</th></tr>{result.data.liabilities.map((row) => <tr key={row.code}><td>{row.name}</td><td className="number">{rupiah(row.amount ?? '0')}</td></tr>)}
      <tr><th>Jumlah liabilitas</th><th className="number">{rupiah(result.data.totalLiabilities)}</th></tr>
      <tr><th colSpan={2}>Ekuitas</th></tr>{result.data.equity.map((row) => <tr key={row.code}><td>{row.name}</td><td className="number">{rupiah(row.amount ?? '0')}</td></tr>)}
      <tr><td>Laba periode berjalan</td><td className="number">{rupiah(result.data.currentPeriodProfit)}</td></tr>
      <tr><th>Jumlah ekuitas</th><th className="number">{rupiah(result.data.totalEquity)}</th></tr>
    </tbody></table>{result.data.difference !== '0.00' && <p className="finance-message finance-error">Neraca belum seimbang: {rupiah(result.data.difference)}.</p>}</section>}
  </>;
}

export function PostingExceptions() {
  const result = useFinanceData<Page<Exception>>('finance/posting-exceptions?limit=50&offset=0');
  const permissions = useFinancePermissions();
  const [message, setMessage] = useState('');
  const canRetry = permissions.includes('finance.posting.period_decision') || permissions.includes('finance.close.manage');
  async function retry(id: string) {
    setMessage('');
    try {
      const response = await fetch(`/api/bff/finance/finance/posting-exceptions/${id}/retry`, {
        method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
      });
      if (!response.ok) throw new Error('Posting belum dapat dicoba lagi. Periksa periode, nilai, dan akun yang diperlukan.');
      setMessage('Posting selesai. Muat ulang halaman untuk melihat status terbaru.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Posting belum dapat dicoba lagi.'); }
  }
  const reason = (code: string) => ({ PERIOD_CLOSED: 'Periode sudah ditutup', PERIOD_NOT_FOUND: 'Periode belum tersedia',
    UNVALUED_INVENTORY: 'Nilai persediaan belum tersedia', POSTING_RULE_NOT_FOUND: 'Aturan posting belum tersedia',
    ACCOUNT_INACTIVE_OR_MISSING: 'Akun belum aktif' } as Record<string, string>)[code] ?? 'Perlu diperiksa';
  return <><h1>Pengecualian Posting</h1><p className="finance-intro">Transaksi berikut memerlukan tindakan sebelum dapat dibukukan.</p>
    <State loading={result.loading} error={result.error} />
    {message && <p role="status" className="finance-message">{message}</p>}
    <section className="finance-panel">{!result.data?.items.length ? <p>Semua transaksi sudah diproses.</p> :
      <table className="finance-table"><thead><tr><th>Tanggal</th><th>Transaksi</th><th>Masalah</th><th>Status</th><th>Aksi</th></tr></thead>
        <tbody>{result.data.items.map((entry) => <tr key={entry.id}><td>{financeDate(entry.business_date)}</td>
          <td>{economicEventLabel(entry.event_type)}</td><td>{reason(entry.reason_code)}</td>
          <td>{entry.status === 'RESOLVED' ? 'Selesai' : 'Perlu ditindaklanjuti'}</td>
          <td>{canRetry && entry.status !== 'RESOLVED' && <button className="finance-button finance-button-secondary" onClick={() => void retry(entry.id)}>Coba lagi</button>}</td>
        </tr>)}</tbody></table>}</section>
  </>;
}
