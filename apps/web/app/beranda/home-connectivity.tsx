'use client';

import { useEffect, useState } from 'react';

export function HomeConnectivity() {
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
  return <div className="pss-offline-banner" role="status">Anda sedang offline. Pekerjaan online tersedia lagi setelah koneksi kembali.</div>;
}
