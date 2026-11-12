import '@pss/ui/components.css';
import './beranda.css';
import type { ReactNode } from 'react';
import { PssAppShell } from '../_shell/pss-app-shell';
import { KasirProviders } from '../kasir/providers';

export default function HomeLayout({ children }: { children: ReactNode }) {
  return <PssAppShell><KasirProviders>{children}</KasirProviders></PssAppShell>;
}
