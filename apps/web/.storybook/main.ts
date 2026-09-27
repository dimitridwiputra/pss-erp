import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/nextjs-vite';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  ...(process.env.PSS_VISUAL_BASE_URL ? { core: { allowedHosts: ['host.docker.internal'] } } : {}),
  framework: { name: '@storybook/nextjs-vite', options: {} },
  viteFinal: (config) => mergeConfig(config, {
    resolve: {
      alias: [{ find: /^@pss\/ui$/, replacement: fileURLToPath(new URL('../../../packages/ui/src/index.ts', import.meta.url)) }],
    },
  }),
};

export default config;
