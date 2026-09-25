import type { Meta, StoryObj } from '@storybook/react';
import { ConfirmationDialog } from '@pss/ui';

const meta = { title: 'Fondasi/Konfirmasi', component: ConfirmationDialog, args: { title: 'Tutup pekerjaan?', description: 'Pekerjaan yang sudah ditutup tidak dapat diubah dari layar ini.', confirmLabel: 'Tutup Pekerjaan', onConfirm: () => undefined, onCancel: () => undefined } } satisfies Meta<typeof ConfirmationDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', errorMessage: 'Pekerjaan belum dapat ditutup. Coba lagi.' } };
