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
 * Every /kantor screen sits in the one app shell (`app/_shell`, docs/mvp/UI_SHELL.md). The shell owns
 * the sidebar, the quick-jump, the account menu and the theme, so nothing here draws a frame.
 *
 * `KantorSessionProvider` is the back office's own addition and lives inside `KasirProviders`: it
 * reads the viewer's own grants once, which is where the warehouse list and the permission tests on
 * the warehouse screens come from. The screens read that context rather than fetching `/me/permissions`
 * each, and the shell reads its own `/api/experience/shell`.
 */
export default function KantorLayout({ children }: { children: ReactNode }) {
  return (
    <PssAppShell>
      <KasirProviders>
        <KantorSessionProvider>{children}</KantorSessionProvider>
      </KasirProviders>
    </PssAppShell>
  );
}
