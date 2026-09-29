import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPssServerAccessToken, getPssSession } from '../../auth';
import { decideApprovalAction } from './actions';

export const metadata = { title: 'Persetujuan | PSS' };

interface ApprovalItem {
  id: string;
  typeCode: string;
  summary: string;
  amount: string | null;
  expiresAt: string;
}

function formatAmount(value: string): string {
  const [integer, decimal] = value.split('.');
  const grouped = (integer ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `Rp ${grouped}${decimal && Number(decimal) !== 0 ? `,${decimal}` : ''}`;
}

const resultCopy: Record<string, string> = {
  done: 'Keputusan tersimpan. Pekerjaan berikutnya sudah diperbarui.',
  stale: 'Permintaan ini sudah diproses petugas lain. Daftar sudah dimuat ulang.',
  mfa: 'Tindakan ini memerlukan verifikasi dua langkah yang baru. Masuk kembali lalu coba lagi.',
  invalid: 'Isi alasan sebelum mengirim keputusan.',
  error: 'Keputusan belum tersimpan. Coba lagi beberapa saat.',
};

export default async function ApprovalInbox({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const session = await getPssSession();
  if (!session?.pssAccount || session.error) redirect('/masuk');
  const token = await getPssServerAccessToken();
  if (!token) redirect('/masuk');
  const response = await fetch(`${process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000'}/platform/approvals/inbox`, {
    headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  if (response.status === 401 || response.status === 403) redirect('/masuk');
  const items: ApprovalItem[] = response.ok ? await response.json() as ApprovalItem[] : [];
  const { result } = await searchParams;

  return (
    <main className="page-shell approval-page">
      <header className="masthead">
        <Link href="/beranda" aria-label="Kembali ke beranda"><Image src="/pss-logo.png" alt="Putra Sumber Sari" width={220} height={73} priority /></Link>
        <Link href="/beranda">Beranda</Link>
      </header>
      <section className="hero" aria-labelledby="approval-title">
        <p className="eyebrow">PEKERJAAN ANDA</p>
        <h1 id="approval-title">Persetujuan</h1>
        <p className="lead">Periksa permintaan yang menjadi wewenang Anda, lalu beri keputusan.</p>
      </section>
      {result && resultCopy[result] && <p className="approval-message" role="status">{resultCopy[result]}</p>}
      {!response.ok ? (
        <section className="status-panel" role="alert">
          <div><h2>Daftar belum dapat dimuat</h2><p>Coba buka halaman ini lagi. Keputusan belum berubah.</p></div>
        </section>
      ) : items.length === 0 ? (
        <section className="status-panel">
          <div><p className="section-label">SELESAI UNTUK SAAT INI</p><h2>Tidak ada persetujuan menunggu</h2><p>Permintaan baru akan muncul di sini saat ditugaskan kepada Anda.</p></div>
        </section>
      ) : (
        <section className="approval-list" aria-label="Permintaan persetujuan">
          {items.map((item) => (
            <article className="status-panel approval-item" key={item.id}>
              <div>
                <p className="section-label">MENUNGGU KEPUTUSAN</p>
                <h2>{item.summary}</h2>
                {item.amount && <p>Nilai: <strong>{formatAmount(item.amount)}</strong></p>}
                <p>Batas waktu: {new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(item.expiresAt))}</p>
                <form action={decideApprovalAction} className="approval-form">
                  <input type="hidden" name="approvalId" value={item.id} />
                  <label htmlFor={`reason-${item.id}`}>Alasan keputusan</label>
                  <textarea id={`reason-${item.id}`} name="reason" minLength={1} maxLength={500} required rows={2} />
                  <div className="approval-actions">
                    <button type="submit" name="decision" value="APPROVED">Setujui</button>
                    <button type="submit" name="decision" value="REJECTED">Tolak</button>
                  </div>
                </form>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
