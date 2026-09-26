import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.mjs', 'packages/**/scripts/**/*.mjs', 'domains/**/scripts/**/*.mjs', 'eslint.config.mjs'], languageOptions: { globals: { process: 'readonly', URL: 'readonly' } } },
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
