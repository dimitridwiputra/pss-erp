'use client';

import { useOnlineStatus } from '../hooks/use-online-status';

/**
 * DESIGN_SYSTEM §9.3. The MVP counter records every sale on the server (offline mode, POS-013, is
 * out of scope), so the notice says plainly that selling waits for the connection.
 */
export function OfflineNotice() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="pss-kasir-offline-banner" role="status">
      <span className="pss-state-dot" aria-hidden="true" /> Offline · Kasir perlu internet untuk mencatat penjualan
    </div>
  );
}
