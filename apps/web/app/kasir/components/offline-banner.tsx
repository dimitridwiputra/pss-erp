'use client';

import { useOnlineStatus } from '../hooks/use-online-status';
import { OfflineBanner as StandardOfflineBanner, SyncStatus } from '@pss/ui';

export function OfflineBanner({ pendingCount }: { pendingCount: number }) {
  const online = useOnlineStatus();
  if (online) return pendingCount === 0 ? null :
    <div className="pss-kasir-offline-banner"><SyncStatus pendingCount={pendingCount} unitLabel="transaksi" /></div>;
  return <StandardOfflineBanner pendingCount={pendingCount} unitLabel="transaksi" className="pss-kasir-offline-banner" />;
}
