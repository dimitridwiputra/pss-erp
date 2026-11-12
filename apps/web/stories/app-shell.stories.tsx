import type { Meta, StoryObj } from '@storybook/react';
import { AppShell, EmptyState, ErrorState, LoadingState, PageHeader, ThemeChoice, type AppShellLinkProps } from '@pss/ui';
import { Home, Receipt, Wallet } from 'lucide-react';

function StoryLink({ href, children, ...rest }: AppShellLinkProps) {
  return <a href={href} {...rest} onClick={(event) => { event.preventDefault(); rest.onClick?.(); }}>{children}</a>;
}

const sections = [
  { key: 'hari-ini', label: 'Hari Ini', items: [{ key: 'beranda', href: '/beranda', label: 'Beranda', icon: <Home size={20} /> }] },
  { key: 'penjualan', label: 'Penjualan', items: [{ key: 'penjualan', href: '/kantor/penjualan', label: 'Penjualan Konter', icon: <Receipt size={20} /> }] },
  { key: 'kas', label: 'Kas', items: [{ key: 'setoran-kas', href: '/kantor/setoran-kas', label: 'Setoran Kas', icon: <Wallet size={20} /> }] },
];

const meta = {
  title: 'Kerangka/App Shell',
  component: AppShell,
  parameters: { layout: 'fullscreen' },
  args: {
    brand: <span>PSS<small>OPERATING PLATFORM</small></span>,
    sections,
    pathname: '/kantor/penjualan',
    Link: StoryLink,
    onNavigate: () => undefined,
    user: { name: 'Admin Demo' },
    userMenu: <ThemeChoice />,
    children: <PageHeader eyebrow="Penjualan" title="Penjualan Konter" description="Transaksi kasir dan fakturnya." />,
  },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { sections: [], user: { name: 'Memuat…' }, children: <LoadingState label="Memuat halaman" /> } };
export const Disabled: Story = { args: { sections: [sections[0]!], children: <EmptyState title="Tidak ada akses" description="Akun Anda tidak memiliki akses ke halaman ini." /> } };
export const Error: Story = { args: { children: <ErrorState problem={{ title: 'Terjadi kendala', message: 'Data belum dapat dimuat. Coba lagi.' }} /> } };
