import '@pss/ui/components.css';
import '../kasir/pos-design.css';
import '../kasir/styles.css';
import './kantor.css';
import type { ReactNode } from 'react';
import { PssAppShell } from '../_shell/pss-app-shell';
import { KasirProviders } from '../kasir/providers';
import { KantorSessionProvider } from './warehouse-context';

export const metadata = { title: 'PSS Kantor' };

/**
 * Every /kantor screen sits in the one app shell. The back-office stream adds its own providers
 * inside `KasirProviders` when its screens land; the frame itself is `PssAppShell`.
 */
export default function KantorLayout({ children }: { children: ReactNode }) {
  return <PssAppShell><KasirProviders><KantorSessionProvider>{children}</KantorSessionProvider></KasirProviders></PssAppShell>;
}
