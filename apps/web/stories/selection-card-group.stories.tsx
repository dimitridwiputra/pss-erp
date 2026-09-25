import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SelectionCardGroup, type SelectionCardGroupProps } from '@pss/ui';

function SelectionExample(args: Omit<SelectionCardGroupProps, 'value' | 'onValueChange'>) {
  const [value, setValue] = useState<string | undefined>();
  return <SelectionCardGroup {...args} value={value} onValueChange={setValue} />;
}

const meta = {
  title: 'Fondasi/Kartu Pilihan',
  component: SelectionExample,
  args: {
    label: 'Kondisi barang',
    name: 'kondisi-barang',
    options: [
      { value: 'good', label: 'Baik', description: 'Barang sesuai dan siap diproses.' },
      { value: 'damaged', label: 'Rusak', description: 'Barang perlu diperiksa.' },
    ],
    state: 'default',
    required: true,
  },
} satisfies Meta<typeof SelectionExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', errorMessage: 'Pilih kondisi barang sebelum melanjutkan.' } };
