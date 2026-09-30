'use client';

import type { CurrentUserResponse } from '@pss/contracts';
import { Avatar } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftRight, Barcode, Boxes, Home, LayoutDashboard, PackagePlus, PenLine, Receipt, Users, Wallet,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { OfflineNotice } from '../kasir/components/offline-notice';
import { kasirFetch } from '../kasir/lib/api-client';
import { useKantorSession } from './warehouse-context';

/**
 * The /kantor shell: one sidebar for every back-office screen, owned by this stream.
 *
 * `/kantor/penjualan` and `/kantor/setoran-kas` were written before the shell existed and drew their
 * own frame. `BackofficeFrame` is now content-only, so both sit inside this shell with no second
 * sidebar and without either of their views being edited.
 *
 * The nav is permission-aware (AGENTS.md §5). A link is **hidden**, not disabled, when the session
 * holds no grant for its permission code: an operator is not shown a screen whose only answer would
 * be "Tidak ada akses" (DESIGN_SYSTEM §5, progressive disclosure). Permission codes are matched,
 * never role codes (RBAC-001.R02). Codes are those of MVP_PLAN §7, which lists what each demo user
 * is granted — so a screen whose code is not in that table is not in this list either.
 */
const NAV_GROUPS = [
  {
    heading: null,
    items: [
      { href: '/kantor', label: 'Dasbor Harian', icon: LayoutDashboard, permission: 'pos.report.view' },
      { href: '/kantor/penjualan', label: 'Penjualan Konter', icon: Receipt, permission: 'pos.report.view' },
      { href: '/kantor/setoran-kas', label: 'Setoran Kas', icon: Wallet, permission: 'payments.cash_custody.verify' },
    ],
  },
  {
    heading: 'Barang dan Harga',
    items: [
      { href: '/kantor/barang', label: 'Barang', icon: Barcode, permission: 'master_data.product.manage' },
      { href: '/kantor/harga', label: 'Harga Jual', icon: PenLine, permission: 'commercial.price_list.manage' },
      { href: '/kantor/pelanggan', label: 'Pelanggan', icon: Users, permission: 'master_data.product.manage' },
    ],
  },
  {
    heading: 'Gudang',
    items: [
      { href: '/kantor/stok', label: 'Stok', icon: Boxes, permission: 'inventory.stock_card.view' },
      { href: '/kantor/terima', label: 'Terima Barang', icon: PackagePlus, permission: 'procurement.receipt.post' },
      { href: '/kantor/penyesuaian', label: 'Penyesuaian Stok', icon: ArrowLeftRight, permission: 'inventory.adjustment.request' },
    ],
  },
] as const;

export function KantorShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { permissions, pending, warehouseId, warehouseIds, setWarehouseId } = useKantorSession();
  const me = useQuery({ queryKey: ['kantor-me'], queryFn: () => kasirFetch<CurrentUserResponse>('/me'), staleTime: 300_000, retry: false });

  const groups = useMemo(
    () => NAV_GROUPS
      .map((group) => ({ heading: group.heading, items: group.items.filter((item) => permissions.has(item.permission)) }))
      .filter((group) => group.items.length > 0),
    [permissions],
  );

  return (
    <div className="pos-preview pos-kasir">
      <aside className="pos-sidebar">
        <div className="pos-brand">
          <Image src="/pss-logo.png" alt="Logo PSS" width={84} height={54} />
          <span>PSS Kantor</span>
        </div>
        <nav aria-label="Menu kantor">
          {groups.map((group) => (
            <div key={group.heading ?? 'utama'}>
              {group.heading && <p className="pos-sidebar-nav-heading">{group.heading}</p>}
              {group.items.map((item) => {
                const active = item.href === '/kantor' ? pathname === item.href : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={active ? 'active' : undefined}>
                    <Icon size={19} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
          {pending && (
            <p style={{ padding: '0 14px', color: 'var(--gray-500)', fontSize: 13 }} role="status">Memuat menu…</p>
          )}
          {!pending && groups.length === 0 && (
            <p style={{ padding: '0 14px', color: 'var(--gray-500)', fontSize: 13, lineHeight: 1.5 }}>
              Belum ada menu untuk hak akses Anda. Hubungi administrator bila ini tidak sesuai.
            </p>
          )}
        </nav>

        <div className="pos-warehouse-picker">
          <label htmlFor="kantor-warehouse">Gudang</label>
          <select
            id="kantor-warehouse"
            value={warehouseId ?? ''}
            onChange={(event) => setWarehouseId(event.target.value)}
            disabled={pending || warehouseIds.length === 0}
          >
            {pending && <option value="">Memuat…</option>}
            {!pending && warehouseIds.length === 0 && <option value="">Tidak ada gudang</option>}
            {warehouseIds.map((id) => <option key={id} value={id}>{id.slice(0, 8)}…</option>)}
          </select>
          <small>
            {pending
              ? 'Memuat cakupan gudang Anda…'
              : warehouseIds.length === 0
                ? 'Akun ini tidak punya cakupan gudang, jadi layar stok tidak dapat menampilkan apa pun.'
                : warehouseIds.length === 1
                  ? 'Gudang yang dipakai di Stok, Terima Barang, dan Penyesuaian.'
                  : 'Pilih gudang yang dipakai di Stok, Terima Barang, dan Penyesuaian.'}
          </small>
        </div>

        <div className="pos-sidebar-bottom">
          <Link href="/beranda"><Home size={22} aria-hidden="true" /> Beranda</Link>
        </div>
      </aside>
      <div className="pos-main-shell">
        <header className="pos-topbar">
          <strong>PSS Kantor</strong>
          <span className="pos-account" style={{ marginLeft: 'auto' }}>
            <Avatar name={me.data?.displayName ?? '?'} />
            <span>{me.data?.displayName ?? (me.isPending ? 'Memuat…' : 'Tamu')}</span>
          </span>
        </header>
        <OfflineNotice />
        <div className="pos-content">{children}</div>
      </div>
    </div>
  );
}
