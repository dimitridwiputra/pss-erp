import type { ReactNode } from 'react';
import { AdminWarehouseProvider } from './warehouse-context';

export const metadata = { title: 'PSS Gudang — Web App' };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminWarehouseProvider>{children}</AdminWarehouseProvider>;
}
