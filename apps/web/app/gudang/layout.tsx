import '@pss/ui/components.css';
import './styles.css';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { GudangProviders } from './providers';
import { OfflineStatus } from './components/offline-status';

export const metadata = { title: 'PSS Gudang' };

export default function GudangLayout({ children }: { children: ReactNode }) {
  // F9 is not released. Keep the development workflow available for testing,
  // while production routes stay absent until its gate and API controls pass.
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <GudangProviders>
      <OfflineStatus />
      {children}
    </GudangProviders>
  );
}
