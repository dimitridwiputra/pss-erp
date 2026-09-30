'use client';

import { ExperienceShellViewSchema, type ExperienceShellView } from '@pss/contracts';
import { AppShell, ThemeChoice, type AppShellLinkProps } from '@pss/ui';
import { LogOut } from 'lucide-react';
import Image from 'next/image';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ShellIcon } from './icons';

function ShellLink({ href, children, ...rest }: AppShellLinkProps) {
  return <NextLink href={href} {...rest}>{children}</NextLink>;
}

type ShellState = { kind: 'loading' } | { kind: 'ready'; view: ExperienceShellView } | { kind: 'unavailable'; signedOut: boolean };

/**
 * Reads the viewer's navigation from the BFF (`/api/experience/shell`) and draws the frame. The
 * page inside keeps its own data and states: if the session has ended, the page says so and offers
 * sign-in; the shell only stops listing screens.
 */
export function AppShellClient({ signOutAction, children }: { signOutAction: () => Promise<void>; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<ShellState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    fetch('/api/experience/shell', { cache: 'no-store' })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) { setState({ kind: 'unavailable', signedOut: response.status === 401 }); return; }
        const parsed = ExperienceShellViewSchema.safeParse(await response.json());
        setState(parsed.success ? { kind: 'ready', view: parsed.data } : { kind: 'unavailable', signedOut: false });
      })
      .catch(() => { if (active) setState({ kind: 'unavailable', signedOut: false }); });
    return () => { active = false; };
  }, []);

  const sections = useMemo(() => (state.kind === 'ready' ? state.view.sections : []).map((section) => ({
    key: section.key,
    label: section.label,
    items: section.items.map((item) => ({ ...item, icon: <ShellIcon name={item.icon} /> })),
  })), [state]);

  const name = state.kind === 'ready' ? state.view.viewer.displayName : state.kind === 'loading' ? 'Memuat…' : 'Akun';
  const incomplete = (state.kind === 'ready' && state.view.incomplete) || (state.kind === 'unavailable' && !state.signedOut);

  return (
    <AppShell
      brand={<><Image src="/pss-logo.png" alt="" width={40} height={40} priority /><span>PSS<small>OPERATING PLATFORM</small></span></>}
      sections={sections}
      pathname={pathname}
      Link={ShellLink}
      onNavigate={(href) => router.push(href)}
      user={{ name }}
      userMenu={(
        <>
          <ThemeChoice />
          <hr className="pss-app-menu-divider" />
          <NextLink className="pss-app-menu-item" href="/beranda" role="menuitem">Beranda</NextLink>
          <form action={signOutAction}>
            <button className="pss-app-menu-item" type="submit" role="menuitem"><LogOut size={18} aria-hidden="true" /> Keluar</button>
          </form>
        </>
      )}
    >
      {incomplete && (
        <p className="pss-shell-incomplete" role="status">Sebagian menu belum terbaca. Muat ulang halaman bila menu yang Anda perlukan tidak ada.</p>
      )}
      {children}
    </AppShell>
  );
}
