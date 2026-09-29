import type { Meta, StoryObj } from '@storybook/react';
import { KpiCard } from '@pss/ui';

const meta = {
  title: 'Fondasi/Kartu KPI',
  component: KpiCard,
  args: {
    icon: '📦',
    tone: 'info',
    label: 'Tugas Aktif',
    value: 48,
    delta: { direction: 'up', label: '+12% vs kemarin' },
  },
} satisfies Meta<typeof KpiCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', errorMessage: 'Ringkasan belum dapat dimuat.' } };
