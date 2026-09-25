import type { Preview } from '@storybook/react';
import '@pss/ui/tokens.css';
import '@pss/ui/components.css';

const preview: Preview = {
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
  },
};

export default preview;
