import type { Meta, StoryObj } from '@storybook/react';
import { Table } from '@pss/ui';

const meta = { title: 'Fondasi/Tabel', component: Table, args: { caption: 'Pekerjaan hari ini', columns: ['Pekerjaan', 'Status'], rows: [['Picking Pagi', 'Siap Diproses'], ['Pengiriman 08.00', 'Selesai']] } } satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error' } };
