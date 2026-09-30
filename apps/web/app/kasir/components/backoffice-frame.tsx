'use client';

import { EmptyState } from '@pss/ui';
import { Home } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { KasirApiError } from '../lib/api-client';
import { OfflineNotice } from './offline-notice';
import { ProblemNotice } from './problem-notice';

/**
 * The frame of the counter's back-office screens (/kantor/penjualan, /kantor/setoran-kas), on the
 * same design as PSS Kasir. It stays deliberately thin: the /kantor shell and navigation are the
 * back-office stream's, and these pages sit inside it once it exists.
 */
export function BackofficeFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pos-preview pos-kasir">
      <aside className="pos-sidebar">
        <div className="pos-brand"><Image src="/pss-logo.png" alt="Logo PSS" width={84} height={54} /><span>PSS Kantor</span></div>
        <div className="pos-sidebar-bottom"><Link href="/beranda"><Home size={22} /> Beranda</Link></div>
      </aside>
      <div className="pos-main-shell">
        <header className="pos-topbar"><strong>PSS · {title}</strong></header>
        <OfflineNotice />
        <main className="pos-content">{children}</main>
      </div>
    </div>
  );
}

/** A refused first load: signed out, switched off, no access, or a failure worth retrying. */
export function BackofficeProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof KasirApiError ? error.problem.code : null;
  if (code === 'UNAUTHENTICATED') {
    return <EmptyState title="Silakan masuk" description="Sesi Anda sudah berakhir. Masuk lagi untuk melanjutkan." action={<Link className="pos-primary" href="/masuk">Masuk</Link>} />;
  }
  if (code === 'PERMISSION_DENIED') {
    return <EmptyState title="Tidak ada akses" description="Akun Anda tidak memiliki akses ke halaman ini." action={<Link className="pos-outline" href="/beranda">Kembali ke Beranda</Link>} />;
  }
  if (code === 'FEATURE_DISABLED' && error instanceof KasirApiError) {
    return <EmptyState title={error.problem.title} description={error.problem.message} action={<Link className="pos-outline" href="/beranda">Kembali ke Beranda</Link>} />;
  }
  return <ProblemNotice error={error} action={<button className="pos-outline" type="button" onClick={onRetry}>Coba Lagi</button>} />;
}
