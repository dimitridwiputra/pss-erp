import type { Meta, StoryObj } from '@storybook/react';
import { Button, ControlStationTemplate } from '@pss/ui';

const meta = {
  title: 'Template/C — Control Station',
  component: ControlStationTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    title: 'Ringkasan operasi',
    filters: <p>Periode, cabang, dan principal dipilih oleh aplikasi.</p>,
    kpis: <p>Belum ada data ringkasan.</p>,
    exceptions: <p>Tidak ada pekerjaan yang perlu ditindaklanjuti.</p>,
    funnel: <p>Alur operasional akan muncul setelah data tersedia.</p>,
    financeSummary: <p>Ringkasan piutang dan keuangan belum tersedia.</p>,
  },
} satisfies Meta<typeof ControlStationTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { kpis: <p>Sedang memuat ringkasan…</p>, exceptions: <p>Sedang memuat pekerjaan…</p> } };
export const Disabled: Story = { args: { feedback: 'Ringkasan belum tersedia untuk cakupan ini.' } };
export const Error: Story = { args: { feedback: <><p>Ringkasan belum dapat dimuat. Periksa koneksi lalu coba lagi.</p><Button label="Coba Lagi" /></> } };
