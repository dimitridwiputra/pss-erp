import type { Meta, StoryObj } from '@storybook/react';
import { ThemeChoice } from '@pss/ui';

const meta = {
  title: 'Kerangka/Pilihan Tampilan',
  component: ThemeChoice,
  decorators: [(Story) => <div className="pss-app-account-menu" style={{ position: 'static' }}><Story /></div>],
} satisfies Meta<typeof ThemeChoice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The choice stores itself in the browser; every state below is the same control in a different surface. */
export const Default: Story = {};
export const Loading: Story = { decorators: [(Story) => <div aria-busy="true"><Story /></div>] };
export const Disabled: Story = { decorators: [(Story) => <fieldset disabled style={{ border: 0, padding: 0 }}><Story /></fieldset>] };
export const Error: Story = { decorators: [(Story) => <div><Story /><p role="alert">Pilihan tampilan tidak dapat disimpan di perangkat ini; berlaku untuk halaman ini saja.</p></div>] };
