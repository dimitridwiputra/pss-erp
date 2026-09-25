import type { Meta, StoryObj } from '@storybook/react';
import { Button, FinanceCloseTemplate } from '@pss/ui';

const meta = {
  title: 'Template/D — Tutup Buku',
  component: FinanceCloseTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    period: 'Periode contoh',
    status: 'Belum siap ditutup',
    progress: <p>Belum ada kemajuan yang dapat ditampilkan.</p>,
    checklist: <p>Daftar pemeriksaan akan tampil setelah periode dipilih.</p>,
    exceptions: <p>Belum ada hasil pemeriksaan.</p>,
    report: <p>Laporan akan muncul setelah data siap ditinjau.</p>,
    closeAction: <Button label="Tutup Periode" state="disabled" />,
  },
} satisfies Meta<typeof FinanceCloseTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { progress: <p>Sedang memuat kemajuan…</p>, closeAction: <Button label="Tutup Periode" state="loading" /> } };
export const Disabled: Story = { args: { feedback: 'Selesaikan pemeriksaan sebelum periode dapat ditutup.' } };
export const Error: Story = { args: { feedback: <><p>Daftar pemeriksaan belum dapat dimuat. Coba lagi.</p><Button label="Coba Lagi" /></> } };
