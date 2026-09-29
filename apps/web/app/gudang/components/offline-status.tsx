'use client';

import { countPendingOfflineConfirmations, openWmsOfflineDatabase } from '@pss/offline';
import { OfflineBanner } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';

export function OfflineStatus() {
  const { data } = useQuery({
    queryKey: ['wms-offline-pending-count'],
    queryFn: () => countPendingOfflineConfirmations(openWmsOfflineDatabase()),
    refetchInterval: 5_000,
    initialData: 0,
  });
  return <OfflineBanner pendingCount={data} unitLabel="pekerjaan" />;
}
