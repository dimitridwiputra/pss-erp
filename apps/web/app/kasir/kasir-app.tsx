'use client';

import type { KasirShiftSayaResponse, PosPickupListResponse } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Home, Moon, Package, ShoppingCart, Sun, Wifi, WifiOff } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OfflineNotice } from './components/offline-notice';
import { ProblemNotice } from './components/problem-notice';
import { useOnlineStatus } from './hooks/use-online-status';
import { KasirCounter } from './kasir-counter';
import { kasirFetch, problemOf } from './lib/api-client';
import { PickupQueue } from './pickup-queue';

type Mode = 'counter' | 'pickup';

const clock = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
const THEME_KEY = 'pss-theme';

/** The counter's clock, in Asia/Jakarta, rendered after hydration so server and client agree. */
function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return <time className="pos-terminal-clock" aria-label="Jam">{now ? clock.format(now) : '--.--'}</time>;
}

/** One tap between light and dark at the counter; the account menu elsewhere offers "follow the device" too. */
function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.dataset.theme === 'dark'); }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try { window.localStorage.setItem(THEME_KEY, next ? 'dark' : 'light'); } catch { /* storage blocked: this page only */ }
  }
  return (
    <button type="button" className="pos-terminal-icon" onClick={toggle} aria-pressed={dark} aria-label={dark ? 'Tampilan terang' : 'Tampilan gelap'} title={dark ? 'Tampilan terang' : 'Tampilan gelap'}>
      {dark ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
    </button>
  );
}

/**
 * PSS Kasir, counter flow only (MVP_PLAN §6.1). Full screen, like a counter terminal: one top bar,
 * the work below. Which work a person sees is the server's answer, not a client flag: the cashier
 * view appears when `/kasir/shift-saya` is allowed, the pickup view when `/pos/pickups` is.
 */
export function KasirApp() {
  const online = useOnlineStatus();
  const counter = useQuery({ queryKey: ['kasir-shift-saya'], queryFn: () => kasirFetch<KasirShiftSayaResponse>('/kasir/shift-saya'), retry: false });
  const pickup = useQuery({ queryKey: ['pos-pickups'], queryFn: () => kasirFetch<PosPickupListResponse>('/pos/pickups'), retry: false });
  const [chosen, setChosen] = useState<Mode | null>(null);

  const refused = (error: unknown) => ['PERMISSION_DENIED', 'NOT_FOUND'].includes(problemOf(error)?.code ?? '');
  const canCount = counter.isSuccess;
  const canPickup = pickup.isSuccess;
  const blocking = [counter.error, pickup.error].map(problemOf).find((problem) => problem && ['UNAUTHENTICATED', 'FEATURE_DISABLED'].includes(problem.code));
  const mode: Mode | null = chosen ?? (canCount ? 'counter' : canPickup ? 'pickup' : null);
  const shift = counter.data?.shift ?? null;

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

  return (
    <div className="pos-preview pos-kasir pos-terminal">
      <header className="pos-terminal-bar">
        <div className="pos-terminal-brand">
          <Image src="/pss-logo.png" alt="Logo PSS" width={36} height={36} priority />
          <span>PSS Kasir</span>
        </div>
        {canCount && canPickup && (
          <nav className="pos-terminal-modes" aria-label="Navigasi kasir">
            <button type="button" className={mode === 'counter' ? 'active' : ''} aria-current={mode === 'counter' ? 'page' : undefined} onClick={() => setChosen('counter')}><ShoppingCart size={18} aria-hidden="true" /> Kasir</button>
            <button type="button" className={mode === 'pickup' ? 'active' : ''} aria-current={mode === 'pickup' ? 'page' : undefined} onClick={() => setChosen('pickup')}><Package size={18} aria-hidden="true" /> Serah Barang</button>
          </nav>
        )}
        {!(canCount && canPickup) && mode && <p className="pos-terminal-title">{mode === 'pickup' ? 'Serah Barang' : 'Kasir'}</p>}
        <div className="pos-terminal-end">
          {mode === 'counter' && shift && (
            <span className={`pos-terminal-chip ${shift.status === 'OPEN' ? 'pos-terminal-chip-open' : ''}`}>
              {shift.terminalName} · {shift.status === 'OPEN' ? 'Shift buka' : 'Shift ditutup'}
            </span>
          )}
          <span className={`pos-terminal-net ${online ? '' : 'pos-terminal-net-off'}`} title={online ? 'Tersambung' : 'Offline'}>
            {online ? <Wifi size={18} aria-hidden="true" /> : <WifiOff size={18} aria-hidden="true" />}<span>{online ? 'Tersambung' : 'Offline'}</span>
          </span>
          <Clock />
          <ThemeToggle />
          <Link className="pos-terminal-icon" href="/beranda" aria-label="Beranda" title="Beranda"><Home size={20} aria-hidden="true" /></Link>
        </div>
      </header>
      <OfflineNotice />
      <main className="pos-content pos-terminal-content">{content}</main>
    </div>
  );
}
