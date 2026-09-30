'use client';

import type { KasirShiftSayaResponse, PosPickupListResponse } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Home, Package, ShoppingCart } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { OfflineNotice } from './components/offline-notice';
import { ProblemNotice } from './components/problem-notice';
import { KasirCounter } from './kasir-counter';
import { kasirFetch, problemOf } from './lib/api-client';
import { PickupQueue } from './pickup-queue';

type Mode = 'counter' | 'pickup';

/**
 * PSS Kasir, counter flow only (MVP_PLAN §6.1). Which work a person sees is the server's answer,
 * not a client flag: the cashier view appears when `/kasir/shift-saya` is allowed, the pickup view
 * when `/pos/pickups` is. Customer, order-list and return menus are not part of the MVP.
 */
export function KasirApp() {
  const counter = useQuery({ queryKey: ['kasir-shift-saya'], queryFn: () => kasirFetch<KasirShiftSayaResponse>('/kasir/shift-saya'), retry: false });
  const pickup = useQuery({ queryKey: ['pos-pickups'], queryFn: () => kasirFetch<PosPickupListResponse>('/pos/pickups'), retry: false });
  const [chosen, setChosen] = useState<Mode | null>(null);

  const refused = (error: unknown) => ['PERMISSION_DENIED', 'NOT_FOUND'].includes(problemOf(error)?.code ?? '');
  const canCount = counter.isSuccess;
  const canPickup = pickup.isSuccess;
  const blocking = [counter.error, pickup.error].map(problemOf).find((problem) => problem && ['UNAUTHENTICATED', 'FEATURE_DISABLED'].includes(problem.code));
  const mode: Mode | null = chosen ?? (canCount ? 'counter' : canPickup ? 'pickup' : null);

  let content;
  if (blocking?.code === 'UNAUTHENTICATED') {
    content = <EmptyState title="Silakan masuk" description="Sesi Anda sudah berakhir. Masuk lagi untuk membuka kasir." action={<Link className="pos-primary" href="/masuk">Masuk</Link>} />;
  } else if (blocking?.code === 'FEATURE_DISABLED') {
    content = <EmptyState title={blocking.title} description={blocking.message} action={<Link className="pos-outline" href="/beranda">Kembali ke Beranda</Link>} />;
  } else if (counter.isPending || pickup.isPending) {
    content = <LoadingState label="Menyiapkan kasir" />;
  } else if (mode === 'counter') {
    content = <KasirCounter />;
  } else if (mode === 'pickup') {
    content = <PickupQueue />;
  } else if (refused(counter.error) && refused(pickup.error)) {
    content = <EmptyState title="Tidak ada pekerjaan kasir untuk Anda" description="Akun Anda tidak memiliki akses kasir atau serah barang di konter." action={<Link className="pos-outline" href="/beranda">Kembali ke Beranda</Link>} />;
  } else {
    content = <ProblemNotice error={counter.error ?? pickup.error} action={<button className="pos-outline" type="button" onClick={() => { void counter.refetch(); void pickup.refetch(); }}>Coba Lagi</button>} />;
  }

  const title = mode === 'pickup' ? 'Serah Barang' : 'Kasir';
  return (
    <div className="pos-preview pos-kasir">
      <aside className="pos-sidebar">
        <div className="pos-brand"><Image src="/pss-logo.png" alt="Logo PSS" width={84} height={54} /><span>PSS Kasir</span></div>
        <nav aria-label="Navigasi kasir">
          {canCount && <button type="button" className={mode === 'counter' ? 'active' : ''} aria-current={mode === 'counter' ? 'page' : undefined} onClick={() => setChosen('counter')}><ShoppingCart size={22} /> Kasir</button>}
          {canPickup && <button type="button" className={mode === 'pickup' ? 'active' : ''} aria-current={mode === 'pickup' ? 'page' : undefined} onClick={() => setChosen('pickup')}><Package size={22} /> Serah Barang</button>}
        </nav>
        <div className="pos-sidebar-bottom"><Link href="/beranda"><Home size={22} /> Beranda</Link></div>
      </aside>
      <div className="pos-main-shell">
        <header className="pos-topbar"><strong>PSS · {title}</strong></header>
        <OfflineNotice />
        <main className="pos-content">{content}</main>
        {(canCount || canPickup) && (
          <nav className="pos-bottom-nav" aria-label="Navigasi kasir mobile">
            {canCount && <button type="button" className={mode === 'counter' ? 'active' : ''} onClick={() => setChosen('counter')}><ShoppingCart size={22} /> Kasir</button>}
            {canPickup && <button type="button" className={mode === 'pickup' ? 'active' : ''} onClick={() => setChosen('pickup')}><Package size={22} /> Serah Barang</button>}
            <Link href="/beranda"><Home size={22} /> Beranda</Link>
          </nav>
        )}
      </div>
    </div>
  );
}
