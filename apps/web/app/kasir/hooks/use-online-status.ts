'use client';

import { useEffect, useState } from 'react';

/** DESIGN_SYSTEM.md §9.3: offline is a normal state, not an error — never blocks an offline-capable workflow. */
export function useOnlineStatus(): boolean {
  // Match the server's initial render; read navigator after hydration to avoid
  // switching the entire cashier screen during React's hydration pass.
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
