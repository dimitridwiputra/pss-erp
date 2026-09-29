import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { EmptyState, ErrorState, StatusPill } from '@pss/ui';
import { getPssServerAccessToken } from '../../auth';
import { resolveApprovalInbox } from '../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../lib/experience/transport';
import type { ExperienceApprovalCard, ExperienceSourceReport } from '@pss/contracts';
import { ApprovalConnectivity } from './approval-connectivity';
import { decideApprovalAction } from './actions';

export const metadata = { title: 'Persetujuan | PSS' };

const INSTANCE = '/persetujuan';

const resultCopy: Record<string, string> = {
  done: 'Keputusan tersimpan. Pekerjaan berikutnya sudah diperbarui.',
  stale: 'Permintaan ini sudah diproses petugas lain. Daftar sudah dimuat ulang.',
  mfa: 'Tindakan ini memerlukan verifikasi dua langkah yang baru. Masuk kembali lalu coba lagi.',
  sod: 'Keputusan ini harus dibuat petugas lain. Teruskan ke atasan Anda.',
  denied: 'Permintaan ini di luar wewenang Anda.',
  expired: 'Permintaan ini sudah tidak berlaku. Daftar sudah dimuat ulang.',
  invalid: 'Isi alasan sebelum mengirim keputusan.',
  error: 'Keputusan belum tersimpan. Coba lagi beberapa saat.',
};

const unavailableCopy: Record<string, string> = {
  identitySelf: 'Identitas akun belum terbaca.',
  identityGrants: 'Daftar wewenang akun belum terbaca.',
  platformApprovalInbox: 'Daftar persetujuan belum terbaca.',
};

function PartialSourceNotice({ sources }: { sources: readonly ExperienceSourceReport[] }) {
  const failed = sources.filter((source) => source.state === 'UNAVAILABLE');
  if (failed.length === 0) return null;
  return (
    <section className="approval-partial" role="status" aria-label="Sebagian data belum terbaca">
      <h2>Sebagian informasi belum terbaca</h2>
      <p>{failed.map((source) => unavailableCopy[source.source] ?? 'Sebagian data belum terbaca.').join(' ')}</p>
      <p>Daftar di bawah mungkin belum lengkap. Muat ulang halaman ini sebentar lagi.</p>
    </section>
  );
}

function ApprovalCard({ card }: { card: ExperienceApprovalCard }) {
  const approve = card.permittedActions.find((action) => action.action === 'APPROVE');
  const reject = card.permittedActions.find((action) => action.action === 'REJECT');
  const reasonRequired = card.permittedActions.some((action) => action.requiresReason);
  return (
    <article className="status-panel approval-item" data-testid="approval-card">
      <div>
        <p className="section-label">MENUNGGU KEPUTUSAN</p>
        <h2>{card.subjectSummary}</h2>
        <StatusPill label={card.status.label} tone={card.status.tone} />
        {card.amountLabel && <p>Nilai: <strong>{card.amountLabel}</strong></p>}
        <p>{card.deadlineLabel}</p>
        <form action={decideApprovalAction} className="approval-form">
          <input type="hidden" name="approvalId" value={card.approvalId} />
          <label htmlFor={`reason-${card.approvalId}`}>Alasan keputusan{reasonRequired ? '' : ' (opsional)'}</label>
          <textarea id={`reason-${card.approvalId}`} name="reason" minLength={1} maxLength={500} required={reasonRequired} rows={2} />
          <div className="approval-actions">
            {approve && <button type="submit" name="decision" value="APPROVED">{approve.label}</button>}
            {reject && <button type="submit" name="decision" value="REJECTED">{reject.label}</button>}
          </div>
        </form>
        <Link className="approval-detail-link" href={card.href}>Lihat detail</Link>
      </div>
    </article>
  );
}

export default async function ApprovalInbox({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const accessToken = await getPssServerAccessToken();
  if (!accessToken) redirect('/masuk');
  const { result } = await searchParams;
  const outcome = await resolveApprovalInbox({
    transport: httpUpstreamTransport,
    accessToken,
    requestId: randomUUID(),
    instance: INSTANCE,
  });
  if (outcome.kind === 'PROBLEM') {
    if (outcome.problem.code === 'UNAUTHENTICATED') redirect('/masuk');
    return (
      <main className="page-shell approval-page">
        <header className="masthead">
          <Link href="/beranda" aria-label="Kembali ke beranda"><Image src="/pss-logo.png" alt="Putra Sumber Sari" width={220} height={73} priority /></Link>
          <Link href="/beranda">Beranda</Link>
        </header>
        <section className="hero" aria-labelledby="approval-title">
          <p className="eyebrow">PEKERJAAN ANDA</p>
          <h1 id="approval-title">Persetujuan</h1>
        </section>
        <ErrorState problem={outcome.problem} action={<Link className="home-primary-link" href={INSTANCE}>Coba lagi</Link>} />
      </main>
    );
  }

  const view = outcome.view;
  const items = view.items;

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
        <ApprovalConnectivity />
      </section>
      {result && resultCopy[result] && <p className="approval-message" role="status">{resultCopy[result]}</p>}
      <PartialSourceNotice sources={view.sources} />
      {items === null ? (
        <section className="status-panel" role="alert">
          <div>
            <h2>Daftar belum dapat dimuat</h2>
            <p>Coba buka halaman ini lagi. Daftar persetujuan Anda belum berubah.</p>
          </div>
        </section>
      ) : items.length === 0 ? (
        <EmptyState
          title="Tidak ada persetujuan menunggu"
          description={view.viewer.canDecide
            ? 'Permintaan baru akan muncul di sini saat ditugaskan kepada Anda.'
            : 'Belum ada wewenang persetujuan untuk akun Anda.'}
          action={<Link className="home-primary-link" href="/beranda">Kembali ke beranda</Link>}
        />
      ) : (
        <section className="approval-list" aria-label="Permintaan persetujuan">
          {items.map((card) => <ApprovalCard card={card} key={card.approvalId} />)}
        </section>
      )}
    </main>
  );
}
