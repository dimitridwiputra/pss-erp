import type { Meta, StoryObj } from '@storybook/react';
import { StatusPill } from '@pss/ui';

const meta = { title: 'Fondasi/Status', component: StatusPill, args: { label: 'Siap Diproses', tone: 'info' } } satisfies Meta<typeof StatusPill>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Disabled: Story = { args: { state: 'disabled' } };
export const Error: Story = { args: { state: 'error', label: 'Perlu Dicek', tone: 'danger' } };
