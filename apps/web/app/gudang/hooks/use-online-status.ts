'use client';

import { useEffect, useState } from 'react';

/** DESIGN_SYSTEM.md §9.3: offline is a normal state, not an error — never blocks an offline-capable workflow. */
export function useOnlineStatus(): boolean {
  // The first client render must match the server before connectivity is read.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
