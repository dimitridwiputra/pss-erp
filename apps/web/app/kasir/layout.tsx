import '@pss/ui/components.css';
import './styles.css';
import type { ReactNode } from 'react';
import { KasirProviders } from './providers';
import { OfflineStatus } from './components/offline-status';

export const metadata = { title: 'PSS Kasir' };

export default function KasirLayout({ children }: { children: ReactNode }) {
  return (
    <KasirProviders>
      <OfflineStatus />
      {children}
    </KasirProviders>
  );
}
