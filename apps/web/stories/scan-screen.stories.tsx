import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ScanScreen, type ScanScreenProps } from '@pss/ui';

function Example(args: Omit<ScanScreenProps, 'code' | 'onCodeChange' | 'onSubmitCode'>) {
  const [code, setCode] = useState('');
  return <ScanScreen {...args} code={code} onCodeChange={setCode} onSubmitCode={() => undefined} />;
}
const meta = { title: 'Fondasi/Scan', component: Example, args: { title: 'Scan barang', target: 'Milo 1 kg · 4 karton', instruction: 'Scan barcode pada kemasan.', state: 'default' } } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', errorMessage: 'Kode tidak cocok. Scan ulang.' } };
