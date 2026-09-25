import type { Meta, StoryObj } from '@storybook/react';
import { TextField } from '@pss/ui';

const meta = {
  title: 'Fondasi/Kolom Teks',
  component: TextField,
  args: { id: 'contoh-kode', label: 'Kode', placeholder: 'Masukkan kode', state: 'default' },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled', defaultValue: 'CONTOH-001' } };
export const Error: Story = { args: { state: 'error', errorMessage: 'Kode wajib diisi.', required: true } };
