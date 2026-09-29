import type { Meta, StoryObj } from '@storybook/react';
import { AdminConsoleTemplate, Avatar, Button, KpiCard, StatusPill, TextField } from '@pss/ui';

const nav = (
  <>
    <a className="pss-admin-nav-link pss-admin-nav-link-active" href="#">Dashboard Gudang</a>
    <a className="pss-admin-nav-link" href="#">Antrian Tugas Operasional</a>
    <a className="pss-admin-nav-link" href="#">Hambatan &amp; Exception</a>
  </>
);

const topBar = (
  <>
    <div className="pss-admin-search"><input placeholder="Cari nomor tugas, SKU, lokasi..." /></div>
    <span className="pss-admin-topbar-spacer" />
    <span className="pss-admin-warehouse-select">Gudang Cikarang</span>
    <span className="pss-admin-notification"><span className="pss-admin-notification-badge">3</span></span>
    <span className="pss-admin-user"><Avatar name="Budi Santoso" /><span className="pss-admin-user-name"><strong>Budi</strong><span>Supervisor</span></span></span>
  </>
);

const meta = {
  title: 'Template/F — Admin Console',
  component: AdminConsoleTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    brand: 'PSS Gudang',
    nav,
    sidebarFooter: <TextField id="story-warehouse-id" label="ID Gudang" defaultValue="GDG-01" />,
    topBar,
    title: 'Dashboard Gudang',
    description: 'Pantau dan kelola seluruh aktivitas operasional gudang secara real-time.',
    children: (
      <dl className="pss-kpi-grid">
        <KpiCard tone="info" icon="📦" label="Tugas Aktif" value={48} delta={{ direction: 'up', label: '+12% vs kemarin' }} />
        <KpiCard tone="danger" icon="⚠️" label="Tugas Macet" value={5} delta={{ direction: 'down', label: '-40% vs kemarin' }} />
      </dl>
    ),
  },
} satisfies Meta<typeof AdminConsoleTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { actions: <StatusPill label="Data real-time" tone="success" /> } };
export const Loading: Story = { args: { children: <p>Sedang memuat data…</p> } };
export const Disabled: Story = { args: { children: <p>Pilih gudang pada bilah sisi untuk menampilkan data.</p> } };
export const Error: Story = { args: { feedback: <><p>Data belum dapat dimuat. Coba lagi.</p><Button label="Coba Lagi" /></> } };
