import type { Meta, StoryObj } from '@storybook/react';
import { Button, CounterTemplate, StatusPill, TextField } from '@pss/ui';

const meta = {
  title: 'Template/E — Konter',
  component: CounterTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    context: 'Konter · Terminal KSR-01 · Shift Budi',
    status: <StatusPill label="Shift Berjalan" tone="info" />,
    scan: <TextField id="scan" label="Scan barang" placeholder="Pindai barcode atau ketik kode" />,
    lines: (
      <ul>
        <li>Indomie Goreng · Karton (40) · Rp118.000</li>
        <li>Aqua 600ml · Dus (24) · Rp42.000</li>
      </ul>
    ),
    summary: (
      <dl>
        <dt>Subtotal</dt><dd>Rp160.000</dd>
        <dt>PPN</dt><dd>Rp17.600</dd>
        <dt>Total</dt><dd>Rp177.600</dd>
      </dl>
    ),
    primaryAction: <Button label="Bayar" />,
    secondaryActions: <Button label="Tahan" tone="secondary" />,
  },
} satisfies Meta<typeof CounterTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = {
  args: { primaryAction: <Button label="Bayar" state="loading" />, feedback: 'Mencadangkan barang…' },
};
export const Disabled: Story = {
  args: { lines: <p>Keranjang kosong.</p>, primaryAction: <Button label="Bayar" state="disabled" /> },
};
export const Error: Story = {
  args: { primaryAction: <Button label="Bayar" state="error" errorMessage="Stok tidak cukup." /> },
};
export const Offline: Story = {
  args: { status: <StatusPill label="Mode Darurat · Tunai Saja" tone="warning" /> },
};
