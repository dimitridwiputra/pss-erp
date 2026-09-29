import type { ReactNode } from 'react';

export function LoadingState({ label = 'Sedang memuat pekerjaan', rows = 3 }: { label?: string; rows?: number }) {
  const safeRows = Math.max(1, Math.min(rows, 8));
  return (
    <div className="pss-loading-state" role="status" aria-label={label} aria-busy="true">
      <span className="pss-visually-hidden">{label}…</span>
      {Array.from({ length: safeRows }, (_, index) => <span className="pss-skeleton-row" aria-hidden="true" key={index} />)}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <section className="pss-standard-state" aria-label={title}>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && <div className="pss-state-action">{action}</div>}
    </section>
  );
}

export interface ErrorStateProps {
  problem?: { title: string; message: string; requestId?: string } | null;
  action?: ReactNode;
}

export function ErrorState({ problem, action }: ErrorStateProps) {
  return (
    <section className="pss-standard-state pss-error-state" role="alert">
      <h2>{problem?.title || 'Terjadi kendala'}</h2>
      <p>{problem?.message || 'Coba lagi sebentar lagi.'}</p>
      {action && <div className="pss-state-action">{action}</div>}
      {problem?.requestId && <details><summary>Rincian untuk bantuan</summary><p>Kode bantuan: {problem.requestId}</p></details>}
    </section>
  );
}

export function OfflineBanner({ pendingCount = 0, unitLabel = 'pekerjaan', className = '' }: {
  pendingCount?: number; unitLabel?: 'pekerjaan' | 'transaksi'; className?: string;
}) {
  return (
    <div className={`pss-offline-banner ${className}`.trim()} role="status">
      <span className="pss-state-dot" aria-hidden="true" />
      Offline · {pendingCount} {unitLabel} menunggu dikirim
    </div>
  );
}

export function SyncStatus({ pendingCount, failedCount = 0, unitLabel = 'pekerjaan' }: {
  pendingCount: number; failedCount?: number; unitLabel?: 'pekerjaan' | 'transaksi';
}) {
  const message = failedCount > 0
    ? `${failedCount} ${unitLabel} perlu diperiksa`
    : pendingCount > 0
      ? `${pendingCount} ${unitLabel} menunggu dikirim`
      : `Semua ${unitLabel} sudah terkirim`;
  return <p className="pss-sync-status" role={failedCount > 0 ? 'alert' : 'status'}>{message}</p>;
}
