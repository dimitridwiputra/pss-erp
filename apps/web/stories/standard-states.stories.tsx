import type { Meta, StoryObj } from '@storybook/react';
import { Button, EmptyState, ErrorState, LoadingState, OfflineBanner, SyncStatus } from '@pss/ui';

const meta = {
  title: 'Fondasi/Keadaan Halaman',
  component: EmptyState,
  args: {
    title: 'Tidak ada pekerjaan saat ini',
    description: 'Semua pekerjaan untuk rute pagi sudah selesai.',
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { action: <Button label="Muat Ulang" /> },
};
export const Loading: Story = {
  render: () => <LoadingState label="Sedang memuat pekerjaan" />,
};
export const Disabled: Story = {
  render: () => <div><OfflineBanner pendingCount={3} /><SyncStatus pendingCount={3} /></div>,
};
export const Error: Story = {
  render: () => <ErrorState problem={{ title: 'Data sudah berubah', message: 'Muat ulang data sebelum melanjutkan.', requestId: 'req-demo' }} action={<Button label="Muat Ulang" />} />,
};
