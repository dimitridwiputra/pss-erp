import '@pss/ui/components.css';
import type { ReactNode } from 'react';
import { signOut } from '../../auth';
import { AppShellClient } from './app-shell-client';

/**
 * The one frame for every desktop work screen: the POS back office, /kantor and /keuangan. A route
 * adopts it from its layout:
 *
 *   export default function Layout({ children }) { return <PssAppShell>{children}</PssAppShell>; }
 *
 * The sidebar lists only the screens the viewer holds a permission for (lib/navigation/work-screens.ts,
 * served by /api/experience/shell). Pages keep their own data loading and their own states.
 */
export function PssAppShell({ children }: { children: ReactNode }) {
  async function signOutAction() {
    'use server';
    await signOut({ redirectTo: '/masuk' });
  }
  return <AppShellClient signOutAction={signOutAction}>{children}</AppShellClient>;
}
