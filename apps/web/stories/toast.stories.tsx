import type { Meta, StoryObj } from '@storybook/react';
import { Toast } from '@pss/ui';

const meta = { title: 'Fondasi/Toast', component: Toast, args: { message: 'Tersimpan', tone: 'success' } } satisfies Meta<typeof Toast>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading', message: 'Akan dikirim saat internet kembali' } };
export const Disabled: Story = { args: { state: 'disabled', tone: 'info' } };
export const Error: Story = { args: { state: 'error', tone: 'danger', message: 'Data belum dapat disimpan.' } };
