import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@pss/ui';

const meta = {
  title: 'Fondasi/Tombol',
  component: Button,
  args: { label: 'Simpan', state: 'default' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', label: 'Coba Lagi', errorMessage: 'Belum tersimpan. Coba lagi.' } };
