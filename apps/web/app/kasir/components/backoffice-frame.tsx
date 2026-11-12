'use client';

import { EmptyState } from '@pss/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { KasirApiError } from '../lib/api-client';
import { OfflineNotice } from './offline-notice';
import { ProblemNotice } from './problem-notice';

/**
 * The region of one counter back-office screen (/kantor/penjualan, /kantor/setoran-kas) inside the
 * app shell (`app/_shell`, adopted by `app/kantor/layout.tsx`). The shell owns the frame, so this
 * draws only the named region, with the counter's own styles available inside it.
 */
export function BackofficeFrame({ title, children }: { title: string; children: ReactNode }) {
  return <section className="pos-kasir pss-embedded" aria-label={title}><OfflineNotice />{children}</section>;
}

/** A refused first load: signed out, switched off, no access, or a failure worth retrying. */
export function BackofficeProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof KasirApiError ? error.problem.code : null;
  if (code === 'UNAUTHENTICATED') {
    return <EmptyState title="Silakan masuk" description="Sesi Anda sudah berakhir. Masuk lagi untuk melanjutkan." action={<Link className="pss-button pss-button-primary" href="/masuk">Masuk</Link>} />;
  }
  if (code === 'PERMISSION_DENIED') {
    return <EmptyState title="Tidak ada akses" description="Akun Anda tidak memiliki akses ke halaman ini." action={<Link className="pss-button pss-button-secondary" href="/beranda">Kembali ke Beranda</Link>} />;
  }
  if (code === 'FEATURE_DISABLED' && error instanceof KasirApiError) {
    return <EmptyState title={error.problem.title} description={error.problem.message} action={<Link className="pss-button pss-button-secondary" href="/beranda">Kembali ke Beranda</Link>} />;
  }
  return <ProblemNotice error={error} action={<button className="pss-button pss-button-secondary" type="button" onClick={onRetry}>Coba Lagi</button>} />;
}
