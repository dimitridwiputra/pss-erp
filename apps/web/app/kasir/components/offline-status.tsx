'use client';

import { countPendingOfflineSales, openPosOfflineDatabase } from '@pss/offline';
import { useQuery } from '@tanstack/react-query';
import { OfflineBanner } from './offline-banner';

export function OfflineStatus() {
  const { data } = useQuery({
    queryKey: ['pos-offline-pending-count'],
    queryFn: () => countPendingOfflineSales(openPosOfflineDatabase()),
    refetchInterval: 5_000,
    initialData: 0,
  });
  return <OfflineBanner pendingCount={data} />;
}
