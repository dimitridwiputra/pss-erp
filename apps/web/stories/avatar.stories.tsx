import type { Meta, StoryObj } from '@storybook/react';
import { Avatar } from '@pss/ui';

const meta = {
  title: 'Fondasi/Avatar',
  component: Avatar,
  args: { name: 'Budi Santoso', size: 'md' },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { presence: 'online' } };
export const Loading: Story = { args: { name: '…' } };
export const Disabled: Story = { args: { name: 'Budi Santoso' } };
export const Error: Story = { args: { name: '?', presence: 'offline' } };
