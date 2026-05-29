// ESLint (flat config) para el TypeScript de la extensión (`src/`). El JS del
// webview vive embebido en `getWebviewContent` (extension.ts) y no se lintea
// como módulo aparte.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
);
