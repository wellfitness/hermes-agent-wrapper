// ESLint (flat config). Lintea el TypeScript del backend (`src/`). La UI de
// `public/` es JavaScript de navegador (vanilla) y queda fuera de este lint TS.
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
    ignores: ['dist/', 'node_modules/', 'public/'],
  },
);
