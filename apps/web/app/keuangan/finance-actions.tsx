'use client';

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { ConfirmationDialog } from '@pss/ui';
import { FinanceManualJournalSchema, type FinanceManualJournalInput } from '@pss/contracts';
import { useFinanceData, useFinancePermissions, financeDate, periodLabel, rupiah } from './finance-client';

type Account = { code: string; name: string; active: boolean };
type Period = { id: string; code: string; status: string };
type Ledger = { openingBalance: string; items: Array<{ journal_id: string; number: string; business_date: string;
  source_document_number: string | null; debit: string; credit: string }>; total: number };

function decimalInput(value: string | undefined): Decimal | null {
  try { return new Decimal(value || 0); } catch { return null; }
}

export function ManualJournalForm() {
  const accounts = useFinanceData<Account[]>('finance/accounts');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const { register, control, handleSubmit, watch, setError, formState: { errors, isSubmitting } } = useForm<FinanceManualJournalInput>({
    defaultValues: { businessDate: today, reason: '', lines: [
      { accountCode: '', debit: '0.00', credit: '0.00', memo: '' },
      { accountCode: '', debit: '0.00', credit: '0.00', memo: '' },
    ] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const [message, setMessage] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const lines = watch('lines');
  const sums = lines.reduce((value, line) => ({ debit: value.debit.plus(decimalInput(line.debit) ?? 0),
    credit: value.credit.plus(decimalInput(line.credit) ?? 0) }), { debit: new Decimal(0), credit: new Decimal(0) });
  const balanced = lines.length >= 2 && sums.debit.greaterThan(0) && sums.debit.equals(sums.credit)
    && lines.every((line) => {
      const debit = decimalInput(line.debit), credit = decimalInput(line.credit);
      if (!debit || !credit) return false;
      return (debit.greaterThan(0) && credit.isZero()) || (credit.greaterThan(0) && debit.isZero());
    });

  async function save(raw: FinanceManualJournalInput) {
    setMessage('');
    const parsed = FinanceManualJournalSchema.safeParse(raw);
    if (!parsed.success) { setError('root', { message: 'Periksa tanggal, alasan, akun, dan jumlah.' }); return; }
    try {
      const response = await fetch('/api/bff/finance/finance/journals', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error('Jurnal belum tersimpan. Periksa data lalu coba lagi.');
      const result = await response.json() as { id: string };
      setDraftId(result.id);
      setMessage('Draf tersimpan. Ajukan persetujuan setelah meninjau kembali baris jurnal.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Jurnal belum tersimpan.'); }
  }

  async function submitDraft() {
    if (!draftId) return;
    try {
      const response = await fetch(`/api/bff/finance/finance/journals/${draftId}/submit`, {
        method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
      });
      if (!response.ok) throw new Error('Jurnal belum dapat diajukan. Periksa akun dan periode, lalu coba lagi.');
      setMessage('Jurnal menunggu persetujuan petugas keuangan lain.');
      setDraftId(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Pengajuan belum berhasil.'); }
  }

  return <><h1>Jurnal Manual</h1><p className="finance-intro">Isi baris debit dan kredit. Jurnal disimpan sebagai draf sebelum persetujuan.</p>
    {accounts.loading && <p role="status" className="finance-message">Daftar akun sedang dimuat…</p>}
    {accounts.error && <p role="alert" className="finance-message finance-error">{accounts.error}</p>}
    <form className="finance-form" onSubmit={handleSubmit(save)}>
      <label>Tanggal bisnis<input type="date" {...register('businessDate')} required /></label>
      <label>Tujuan dan alasan<textarea {...register('reason')} required maxLength={500} /></label>
      <section className="finance-panel"><h2>Baris jurnal</h2>{fields.map((field, index) => <div className="finance-form-row" key={field.id}>
        <label>Akun<select {...register(`lines.${index}.accountCode`)} required><option value="">Pilih akun</option>
          {accounts.data?.filter((account) => account.active).map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label>
        <label>Debit<input type="text" inputMode="decimal" {...register(`lines.${index}.debit`)} /></label>
        <label>Kredit<input type="text" inputMode="decimal" {...register(`lines.${index}.credit`)} /></label>
        <label>Catatan<input type="text" {...register(`lines.${index}.memo`)} /></label>
        {fields.length > 2 && <button className="finance-button finance-button-secondary" type="button" onClick={() => remove(index)}>Hapus baris</button>}
      </div>)}
        <button type="button" className="finance-button finance-button-secondary" onClick={() => append({ accountCode: '', debit: '0.00', credit: '0.00', memo: '' })}>Tambah baris</button>
      </section>
      <p role="status" className={`finance-message ${balanced ? 'finance-success' : ''}`}>
        Debit {rupiah(sums.debit.toFixed(2))} · Kredit {rupiah(sums.credit.toFixed(2))} · {balanced ? 'Seimbang' : 'Belum seimbang'}
      </p>
      {errors.root && <p role="alert" className="finance-message finance-error">{errors.root.message}</p>}
      {message && <p role="status" className="finance-message">{message}</p>}
      {draftId && <p><Link href={`/keuangan/jurnal/${draftId}`}>Tinjau draf jurnal</Link></p>}
      <div className="finance-actions"><button className="finance-button" type="submit" disabled={!balanced || isSubmitting || !accounts.data}>Simpan draf</button>
        {draftId && <button className="finance-button" type="button" onClick={() => void submitDraft()}>Ajukan persetujuan</button>}</div>
    </form></>;
}

export function GeneralLedger() {
  const accounts = useFinanceData<Account[]>('finance/accounts');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [account, setAccount] = useState('1-1100');
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const ledger = useFinanceData<Ledger>(`finance/ledger?accountCode=${account}&from=${from}&to=${to}&limit=50&offset=0`);
  return <><h1>Buku Besar</h1><p className="finance-intro">Pilih akun dan rentang tanggal untuk menelusuri jurnal yang dibukukan.</p>
    <div className="finance-form-row"><label>Akun<select value={account} onChange={(event) => setAccount(event.target.value)}>
      {accounts.data?.map((entry) => <option key={entry.code} value={entry.code}>{entry.code} · {entry.name}</option>)}</select></label>
      <label>Dari<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>Sampai<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
    {ledger.loading && <p role="status" className="finance-message">Buku besar sedang dimuat…</p>}
    {ledger.error && <p role="alert" className="finance-message finance-error">{ledger.error}</p>}
    {ledger.data && <section className="finance-panel"><p>Saldo awal: {rupiah(ledger.data.openingBalance)}</p>
      {!ledger.data.items.length ? <p>Belum ada transaksi pada rentang ini.</p> :
        <table className="finance-table"><thead><tr><th>Tanggal</th><th>Jurnal</th><th>Dokumen</th><th className="number">Debit</th><th className="number">Kredit</th></tr></thead>
          <tbody>{ledger.data.items.map((item) => <tr key={`${item.journal_id}-${item.number}`}><td>{financeDate(item.business_date)}</td>
            <td><Link href={`/keuangan/jurnal/${item.journal_id}`}>{item.number}</Link></td><td>{item.source_document_number ?? 'Jurnal manual'}</td>
            <td className="number">{rupiah(item.debit)}</td><td className="number">{rupiah(item.credit)}</td></tr>)}</tbody></table>}
    </section>}
  </>;
}

export function Periods() {
  const result = useFinanceData<Period[]>('finance/periods');
  const permissions = useFinancePermissions();
  const canManage = permissions.includes('finance.close.manage');
  const canReopen = permissions.includes('finance.period.reopen.request');
  const [selected, setSelected] = useState<{ id: string; action: 'soft-close' | 'close' | 'reopen-requests'; code: string } | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function act() {
    if (!selected || !reason.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/bff/finance/finance/periods/${selected.id}/${selected.action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(selected.action === 'close' ? { reason, overrideExceptions: false } : { reason }),
      });
      if (!response.ok) throw new Error('Permintaan belum dapat diproses. Periksa pengecualian posting atau status periode.');
      setMessage(selected.action === 'soft-close'
        ? 'Periode ditutup sementara. Muat ulang halaman untuk melihat hasil.'
        : 'Permintaan menunggu persetujuan petugas lain.');
      setSelected(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Periode belum dapat diperbarui.'); }
    finally { setBusy(false); }
  }

  return <><h1>Periode</h1><p className="finance-intro">Tinjau periode dan alasan sebelum menutup buku.</p>
    {result.loading && <p role="status" className="finance-message">Periode sedang dimuat…</p>}
    {result.error && <p role="alert" className="finance-message finance-error">{result.error}</p>}
    {message && <p role="status" className="finance-message">{message}</p>}
    <section className="finance-panel">{!result.data?.length ? <p>Belum ada periode. Minta admin menjalankan seed demo keuangan.</p> :
      <table className="finance-table"><thead><tr><th>Periode</th><th>Status</th><th>Aksi</th></tr></thead>
        <tbody>{result.data.map((period) => <tr key={period.id}><td>{period.code}</td><td>{periodLabel(period.status)}</td>
          <td>{canManage && period.status === 'OPEN' ? <button className="finance-button" onClick={() => setSelected({ id: period.id, code: period.code, action: 'soft-close' })}>Tutup sementara</button>
            : canManage && period.status === 'SOFT_CLOSED' ? <button className="finance-button" onClick={() => setSelected({ id: period.id, code: period.code, action: 'close' })}>Tutup periode</button>
              : canReopen && period.status === 'CLOSED'
                ? <button className="finance-button" onClick={() => setSelected({ id: period.id, code: period.code, action: 'reopen-requests' })}>Ajukan buka kembali</button>
                : <span>Ditutup</span>}</td></tr>)}</tbody></table>}
    </section>
    {selected && <><div className="finance-panel finance-form"><label>Alasan tindakan<textarea value={reason} onChange={(event) => setReason(event.target.value)} required /></label></div>
      <ConfirmationDialog title={`${selected.action === 'reopen-requests' ? 'Buka kembali' : 'Tutup'} periode ${selected.code}?`}
        description={selected.action === 'soft-close' ? 'Periode akan ditutup sementara.' : 'Permintaan ini memerlukan persetujuan petugas lain.'}
        confirmLabel={selected.action === 'reopen-requests' ? 'Ajukan buka kembali' : selected.action === 'close' ? 'Ajukan tutup periode' : 'Tutup sementara'}
        onConfirm={() => void act()} onCancel={() => { setSelected(null); setReason(''); }}
        state={busy || !reason.trim() ? 'disabled' : 'default'} /></>}
  </>;
}
