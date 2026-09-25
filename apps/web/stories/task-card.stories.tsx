import type { Meta, StoryObj } from '@storybook/react';
import { TaskCard } from '@pss/ui';

const meta = {
  title: 'Fondasi/Kartu Tugas',
  component: TaskCard,
  args: {
    title: 'Pekerjaan berikutnya',
    objectName: 'Contoh barang',
    details: '4 karton · Rak contoh',
    actionLabel: 'Mulai',
    state: 'default',
  },
} satisfies Meta<typeof TaskCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', actionLabel: 'Coba Lagi', errorMessage: 'Pekerjaan belum terbuka. Coba lagi.' } };
