import type { Meta, StoryObj } from '@storybook/react';
import { Button, MobileTaskTemplate, TaskCard } from '@pss/ui';

const meta = {
  title: 'Template/A — Tugas Mobile',
  component: MobileTaskTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    context: 'Contoh pekerjaan gudang',
    instruction: 'Ambil barang berikutnya',
    object: <TaskCard title="Ambil barang" objectName="Barang contoh" details="4 karton · Rak contoh" actionLabel="Lihat Rincian" />,
    details: <p>Pastikan barang dan jumlah sesuai sebelum melanjutkan.</p>,
    action: <Button label="Mulai" />,
  },
} satisfies Meta<typeof MobileTaskTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { object: <p>Sedang memuat pekerjaan…</p>, action: <Button label="Mulai" state="loading" /> } };
export const Disabled: Story = { args: { object: <p>Belum ada pekerjaan yang tersedia.</p>, action: <Button label="Mulai" state="disabled" /> } };
export const Error: Story = { args: { feedback: 'Pekerjaan belum dapat dimuat. Periksa koneksi lalu coba lagi.', action: <Button label="Coba Lagi" /> } };
