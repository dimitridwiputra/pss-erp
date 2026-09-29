import '@pss/ui/components.css';
import './styles.css';
import type { ReactNode } from 'react';
import { GudangProviders } from './providers';
import { OfflineStatus } from './components/offline-status';

export const metadata = { title: 'PSS Gudang' };

export default function GudangLayout({ children }: { children: ReactNode }) {
  return (
    <GudangProviders>
      <OfflineStatus />
      {children}
    </GudangProviders>
  );
}
