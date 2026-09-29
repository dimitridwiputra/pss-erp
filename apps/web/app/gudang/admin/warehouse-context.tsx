'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'pss-gudang-admin-warehouse-id';

const WarehouseContext = createContext<{ warehouseId: string; setWarehouseId: (id: string) => void } | null>(null);

export function AdminWarehouseProvider({ children }: { children: ReactNode }) {
  const [warehouseId, setWarehouseId] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setWarehouseId(stored);
  }, []);

  const update = (id: string) => {
    setWarehouseId(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  };

  return <WarehouseContext.Provider value={{ warehouseId, setWarehouseId: update }}>{children}</WarehouseContext.Provider>;
}

/** The warehouse a supervisor is currently viewing in the admin console — a session-scoped filter, not a URL resource id. */
export function useAdminWarehouse() {
  const context = useContext(WarehouseContext);
  if (!context) throw new Error('useAdminWarehouse must be used within AdminWarehouseProvider');
  return context;
}
