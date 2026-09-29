'use client';

import { useEffect, useState } from 'react';

/**
 * DSY §9.3 / UX-003. The approval inbox is an online-only screen, so the offline notice
 * has to say what happens instead of showing a queue of pending uploads that do not exist
 * here. It renders nothing while the browser reports an online connection.
 */
export function ApprovalConnectivity() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="pss-offline-banner" role="status">
      <span aria-hidden="true">●</span>
      Anda sedang offline. Daftar persetujuan muncul lagi setelah koneksi kembali.
    </div>
  );
}
