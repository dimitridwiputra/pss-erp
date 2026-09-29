'use client';

import { EmptyState } from '@pss/ui';
import type { ReactNode } from 'react';
import { useAdminWarehouse } from './warehouse-context';

/** Every admin screen needs a warehouse selected first (set once in the sidebar, shared across all screens). */
export function RequireWarehouse({ children }: { children: (warehouseId: string) => ReactNode }) {
  const { warehouseId } = useAdminWarehouse();
  if (!warehouseId) {
    return <EmptyState title="Pilih gudang" description="Masukkan ID Gudang pada bilah sisi untuk menampilkan data." />;
  }
  return <>{children(warehouseId)}</>;
}
