'use client';

import type { CurrentUserResponse, ExceptionQueueResponse } from '@pss/contracts';
import { AdminConsoleTemplate, Avatar, TextField } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, ClipboardList, LayoutDashboard, ListChecks, MapPin, Users, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';
import { gudangFetch } from '../lib/api-client';
import { useAdminWarehouse } from './warehouse-context';

const NAV_ITEMS = [
  { href: '/gudang/admin', label: 'Dashboard Gudang', icon: LayoutDashboard },
  { href: '/gudang/admin/tugas', label: 'Antrian Tugas Operasional', icon: ListChecks },
  { href: '/gudang/admin/exceptions', label: 'Hambatan & Exception', icon: AlertTriangle },
  { href: '/gudang/admin/petugas', label: 'Petugas Aktif', icon: Users },
  { href: '/gudang/admin/lokasi', label: 'Stok Lokasi', icon: MapPin },
  { href: '/gudang/admin/laporan', label: 'Laporan Gudang', icon: ClipboardList },
];

function useCurrentUser() {
  return useQuery({ queryKey: ['gudang-admin-me'], queryFn: () => gudangFetch<CurrentUserResponse>('/me'), retry: 0, staleTime: 60_000 });
}

function useOpenExceptionCount(warehouseId: string) {
  return useQuery({
    queryKey: ['gudang-admin-open-exceptions', warehouseId],
    queryFn: () => gudangFetch<ExceptionQueueResponse>(`/wms/exceptions?warehouseId=${warehouseId}&status=OPEN`),
    enabled: Boolean(warehouseId),
    refetchInterval: 30_000,
  });
}

export function AdminShell({ title, description, actions, feedback, children }: {
  title: string; description?: string; actions?: ReactNode; feedback?: ReactNode; children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { warehouseId, setWarehouseId } = useAdminWarehouse();
  const currentUser = useCurrentUser();
  const openExceptions = useOpenExceptionCount(warehouseId);
  const [search, setSearch] = useState('');
  const openCount = openExceptions.data?.items.length ?? 0;

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    const query = search.trim();
    if (!query) return;
    router.push(`/gudang/admin/tugas?q=${encodeURIComponent(query)}`);
  };

  const nav = (
    <>
      {NAV_ITEMS.map((item) => {
        const active = item.href === '/gudang/admin' ? pathname === item.href : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href} className={`pss-admin-nav-link${active ? ' pss-admin-nav-link-active' : ''}`} aria-current={active ? 'page' : undefined}>
            <Icon aria-hidden="true" /> {item.label}
          </Link>
        );
      })}
    </>
  );

  const sidebarFooter = (
    <TextField
      id="admin-warehouse-id" label="ID Gudang" value={warehouseId}
      onChange={(event) => setWarehouseId(event.target.value)}
      helperText="Menentukan gudang yang ditampilkan di semua layar"
    />
  );

  const topBar = (
    <>
      <form className="pss-admin-search" role="search" onSubmit={onSearch}>
        <input
          value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari nomor tugas, SKU, atau lokasi…" aria-label="Cari tugas, SKU, atau lokasi"
        />
      </form>
      <span className="pss-admin-topbar-spacer" />
      {warehouseId && <span className="pss-admin-warehouse-select" title={warehouseId}><Warehouse size={16} aria-hidden="true" /> {warehouseId.slice(0, 8)}…</span>}
      <Link href="/gudang/admin/exceptions" className="pss-admin-notification" aria-label={`${openCount} hambatan terbuka`}>
        <Bell size={18} aria-hidden="true" />
        {openCount > 0 && <span className="pss-admin-notification-badge">{openCount}</span>}
      </Link>
      <span className="pss-admin-user">
        <Avatar name={currentUser.data?.displayName ?? '?'} />
        <span className="pss-admin-user-name"><strong>{currentUser.data?.displayName ?? (currentUser.isPending ? 'Memuat…' : 'Tamu')}</strong></span>
      </span>
    </>
  );

  return (
    <AdminConsoleTemplate
      brand={<><Warehouse aria-hidden="true" /> PSS Gudang</>}
      nav={nav}
      sidebarFooter={sidebarFooter}
      topBar={topBar}
      breadcrumb={<>Operasional / Gudang</>}
      title={title}
      {...(description ? { description } : {})}
      actions={actions}
      feedback={feedback}
    >
      {children}
    </AdminConsoleTemplate>
  );
}
