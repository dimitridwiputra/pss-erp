import type { Meta, StoryObj } from '@storybook/react';
import { ErrorState, LoadingState, PageHeader, Panel } from '@pss/ui';

const meta = {
  title: 'Kerangka/Judul Halaman',
  component: PageHeader,
  args: {
    eyebrow: 'Kas',
    title: 'Setoran Kas Konter',
    description: 'Hitung uang dari kasir, lalu terima setorannya.',
    actions: <button className="pss-button pss-button-primary" type="button">Terima Setoran</button>,
  },
  decorators: [(Story) => <div style={{ display: 'grid', gap: 24 }}><Story /><Panel title="Setoran dari kasir"><p>Isi panel.</p></Panel></div>],
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { actions: undefined, description: <LoadingState label="Memuat" rows={1} /> } };
export const Disabled: Story = { args: { actions: <button className="pss-button pss-button-primary" type="button" disabled>Terima Setoran</button> } };
export const Error: Story = { args: { actions: undefined, description: <ErrorState problem={{ title: 'Terjadi kendala', message: 'Coba lagi sebentar lagi.' }} /> } };
