import '@pss/ui/components.css';
import './styles.css';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { KasirProviders } from './providers';
import { OfflineStatus } from './components/offline-status';

export const metadata = { title: 'PSS Kasir' };

export default function KasirLayout({ children }: { children: ReactNode }) {
  // The F11 cashier flow is still development work; the deployable POS API is
  // intentionally unregistered. Do not present this screen as live in production.
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <KasirProviders>
      <OfflineStatus />
      {children}
    </KasirProviders>
  );
}
