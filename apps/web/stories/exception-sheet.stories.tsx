import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ExceptionSheet, type ExceptionSheetProps } from '@pss/ui';

function Example(args: Omit<ExceptionSheetProps, 'selectedReason' | 'onReasonChange' | 'onSubmit'>) {
  const [reason, setReason] = useState<string>();
  return <ExceptionSheet {...args} selectedReason={reason} onReasonChange={setReason} onSubmit={() => undefined} />;
}
const meta = { title: 'Fondasi/Pengecualian', component: Example, args: { title: 'Barang kurang', requested: '10 karton', available: '8 karton', reasons: [{ value: 'out', label: 'Stok habis' }, { value: 'damaged', label: 'Barang rusak' }, { value: 'wrong', label: 'Salah lokasi' }], state: 'default' } } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', errorMessage: 'Pilih alasan sebelum melaporkan.' } };
