import { randomUUID } from 'node:crypto';
import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ErrorState, StatusPill } from '@pss/ui';
import { getPssServerAccessToken } from '../../../auth';
import type { ExperienceApprovalCard } from '../../../lib/experience/contract';
import { resolveApprovalDetail } from '../../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../../lib/experience/transport';
import { ApprovalConnectivity } from '../approval-connectivity';
import { decideApprovalAction } from '../actions';

const INSTANCE = '/persetujuan';

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="page-shell approval-page">
      <header className="masthead">
        <Link href="/beranda" aria-label="Kembali ke beranda"><Image src="/pss-logo.png" alt="Putra Sumber Sari" width={220} height={73} priority /></Link>
        <Link href={INSTANCE}>Daftar persetujuan</Link>
      </header>
      {children}
    </main>
  );
}

/** RBAC-003.R02 applied to approvals: a deep link outside the caller's scope explains nothing technical. */
function NoAccess() {
  return (
    <PageFrame>
      <section className="hero" aria-labelledby="detail-title">
        <p className="eyebrow">PERSETUJUAN</p>
        <h1 id="detail-title">Tidak ada akses</h1>
        <p className="lead">Persetujuan ini bukan wewenang Anda, atau permintaannya sudah selesai diproses.</p>
      </section>
      <section className="status-panel">
        <div>
          <h2>Anda tidak dapat membuka permintaan ini</h2>
          <p>Jika Anda merasa ini keliru, hubungi Admin Sistem.</p>
        </div>
        <Link className="home-primary-link" href={INSTANCE}>Kembali ke daftar</Link>
      </section>
    </PageFrame>
  );
}

function DetailCard({ card }: { card: ExperienceApprovalCard }) {
  const approve = card.permittedActions.find((action) => action.action === 'APPROVE');
  const reject = card.permittedActions.find((action) => action.action === 'REJECT');
  const reasonRequired = card.permittedActions.some((action) => action.requiresReason);
  return (
    <section className="status-panel approval-item" data-testid="approval-detail">
      <div>
        <p className="section-label">MENUNGGU KEPUTUSAN</p>
        <h2>{card.subjectSummary}</h2>
        <StatusPill label={card.status.label} tone={card.status.tone} />
        {card.amountLabel && <p>Nilai: <strong>{card.amountLabel}</strong></p>}
        <p>{card.deadlineLabel}</p>
        <form action={decideApprovalAction} className="approval-form">
          <input type="hidden" name="approvalId" value={card.approvalId} />
          <label htmlFor="reason-detail">Alasan keputusan{reasonRequired ? '' : ' (opsional)'}</label>
          <textarea id="reason-detail" name="reason" minLength={1} maxLength={500} required={reasonRequired} rows={3} />
          <div className="approval-actions">
            {approve && <button type="submit" name="decision" value="APPROVED">{approve.label}</button>}
            {reject && <button type="submit" name="decision" value="REJECTED">{reject.label}</button>}
          </div>
        </form>
      </div>
    </section>
  );
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ approvalId: string }> }) {
  const accessToken = await getPssServerAccessToken();
  if (!accessToken) redirect('/masuk');
  const { approvalId } = await params;
  const outcome = await resolveApprovalDetail({
    transport: httpUpstreamTransport,
    accessToken,
    requestId: randomUUID(),
    instance: `${INSTANCE}/{approvalId}`,
  }, approvalId);

  if (outcome.kind === 'PROBLEM') {
    if (outcome.problem.code === 'UNAUTHENTICATED') redirect('/masuk');
    if (outcome.problem.code === 'PERMISSION_DENIED') return <NoAccess />;
    return (
      <PageFrame>
        <ErrorState problem={outcome.problem} action={<Link className="home-primary-link" href={INSTANCE}>Kembali ke daftar</Link>} />
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      <section className="hero" aria-labelledby="detail-title">
        <p className="eyebrow">PERSETUJUAN</p>
        <h1 id="detail-title">Detail persetujuan</h1>
        <p className="lead">Periksa konteksnya, lalu beri keputusan.</p>
        <ApprovalConnectivity />
      </section>
      <DetailCard card={outcome.view.card} />
    </PageFrame>
  );
}
