import type { Meta, StoryObj } from '@storybook/react';
import { Button, QueueTemplate, TextField } from '@pss/ui';

const meta = {
  title: 'Template/B — Antrian Desktop',
  component: QueueTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    title: 'Antrian pekerjaan',
    count: 0,
    filters: <TextField id="queue-search" label="Cari pekerjaan" name="search" helperText="Cari berdasarkan nomor atau nama." />,
    tabs: <><span>Semua</span><span>Perlu Dicek</span><span>Terlambat</span></>,
    items: <p>Belum ada pekerjaan dalam antrian ini.</p>,
    detail: <p>Pilih pekerjaan untuk melihat rincian.</p>,
  },
} satisfies Meta<typeof QueueTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { items: <p>Sedang memuat antrian…</p> } };
export const Disabled: Story = { args: { filters: <TextField id="queue-search-disabled" label="Cari pekerjaan" name="search" state="disabled" />, detail: <p>Rincian belum tersedia.</p> } };
export const Error: Story = { args: { feedback: <><p>Antrian belum dapat dimuat. Periksa koneksi lalu coba lagi.</p><Button label="Coba Lagi" /></> } };
