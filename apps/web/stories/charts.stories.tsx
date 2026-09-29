import type { Meta, StoryObj } from '@storybook/react';
import { DonutChart, HorizontalBarChart, TrendLineChart, VerticalBarChart } from '@pss/ui';

function ChartsGallery({ empty = false }: { empty?: boolean }) {
  const trend = empty ? [] : [
    { label: '1 Sep', value: 12 }, { label: '8 Sep', value: 18 }, { label: '15 Sep', value: 14 }, { label: '22 Sep', value: 22 },
  ];
  const bars = empty ? [] : [{ label: 'Receiving', value: 8 }, { label: 'Putaway', value: 6 }, { label: 'Pick', value: 18 }];
  const donut = empty ? [] : [{ label: 'Pick', value: 18 }, { label: 'Receiving', value: 8 }, { label: 'Putaway', value: 6 }];
  return (
    <div style={{ display: 'grid', gap: '2rem', padding: '1.5rem', background: 'var(--pss-cream-50)' }}>
      <TrendLineChart points={trend} />
      <VerticalBarChart bars={bars} />
      <HorizontalBarChart bars={bars} />
      <DonutChart segments={donut} />
    </div>
  );
}

const meta = {
  title: 'Fondasi/Grafik',
  component: ChartsGallery,
} satisfies Meta<typeof ChartsGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { empty: true } };
export const Disabled: Story = { args: { empty: true } };
export const Error: Story = { args: { empty: true } };
