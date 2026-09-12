// ESLint flat config (ESLint 9). Intentionally ADVISORY: rules that would
// otherwise force edits to existing `src/**` are set to "warn" (or off), so
// `npm run lint` surfaces issues without erroring the build. Tighten to "error"
// over time as the codebase is cleaned up.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  // never lint build output, deps, the wasm glue, or coverage reports.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/solver/**',
      'coverage/**',
      'vite.config.ts',
      'vitest.config.ts',
    ],
  },

  // base JS + TS recommended (non-type-checked: fast, no tsconfig project wiring
  // needed, and it won't choke on test/helper files outside `include`).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // react-hooks correctness — keep these as warnings (advisory).
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',

      // these commonly fire on existing, deliberate code (the solver leans on
      // `any` at the wasm boundary, etc.). Advisory only — do not block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // test + node-side helper/script files: allow Node + Vitest globals.
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/testHelpers.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },

  // CommonJS Node harness scripts (e.g. the puppeteer `shot.cjs` screenshotter).
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      // harness scripts intentionally bind locals named like web globals (URL …).
      'no-redeclare': 'off',
    },
  },
)
