// @ts-check
/**
 * Flat ESLint config.
 *
 * Priorities, in order:
 *   1. Catch async mistakes. SPEC.md §8 hangs correctness on message-handling paths that must
 *      not swallow errors — a floating promise in the JSON-RPC event pump is a dropped
 *      message, and a dropped message looks like the app is broken rather than like a bug.
 *      `no-floating-promises`, `no-misused-promises` and `await-thenable` are the whole reason
 *      this config is type-aware.
 *   2. Enforce the process boundary from SPEC.md §3: renderers are pure views. Renderer code
 *      may not import Electron main-process APIs, node builtins, or the database driver, and
 *      may not reach the network directly.
 *   3. Stay quiet enough to survive. Rules that fire constantly get disabled, so stylistic
 *      opinions are left to Prettier and only bug-shaped rules are errors here.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default tseslint.config(
  // ---------------------------------------------------------------------------
  // Ignores
  // ---------------------------------------------------------------------------
  {
    ignores: [
      '**/node_modules/**',
      'out/**',
      'dist/**',
      'build/**',
      'release/**',
      'coverage/**',
      'resources/**',
      '**/*.d.ts',
    ],
  },

  // ---------------------------------------------------------------------------
  // Baseline
  // ---------------------------------------------------------------------------
  js.configs.recommended,

  // ---------------------------------------------------------------------------
  // TypeScript, type-aware
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files are not in any tsconfig; lint them without type info.
          allowDefaultProject: ['*.js', '*.mjs', '*.cjs', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript already resolves every identifier; no-undef only produces false positives.
      'no-undef': 'off',

      // ---- async correctness: the point of this config -----------------------
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // `void doThing()` is the explicit "I meant to fire and forget" escape hatch.
          // Anything else must be awaited or carry a .catch().
          ignoreVoid: true,
          ignoreIIFE: false,
          checkThenables: true,
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksConditionals: true,
          checksSpreads: true,
          checksVoidReturn: {
            arguments: true,
            attributes: false, // see note below
            properties: true,
            returns: true,
            variables: true,
          },
        },
      ],
      // `attributes: false` permits `onClick={async () => …}`. Turned off because the
      // alternative fires on nearly every interactive component and then gets disabled
      // wholesale — a dead rule catches nothing. The obligation still stands: an async JSX
      // handler must not let a rejection escape. Wrap the body in try/catch or route it
      // through a shared handler.
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'], // keeps async stack traces intact
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      'require-atomic-updates': 'error',

      // ---- correctness -------------------------------------------------------
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      // Message `kind` and connection-state unions must be handled exhaustively (SPEC.md §8).
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off', // main-process logging is legitimate

      // ---- ergonomics: real signal, low noise --------------------------------
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      // Off: single-target codebase, these two mostly generate ceremony.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Main process and preload — Node globals; owns the network and the database (SPEC.md §3)
  // ---------------------------------------------------------------------------
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', '*.config.{ts,mts,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ---------------------------------------------------------------------------
  // Renderer — React, browser globals, network-silent
  // ---------------------------------------------------------------------------
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules, // no `import React` needed

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      'react/jsx-no-target-blank': 'error',
      'react/no-unstable-nested-components': 'error',
      'react/jsx-key': ['error', { checkFragmentShorthand: true }],
      'react/self-closing-comp': 'error',

      // TypeScript covers these.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',

      // SPEC.md §3: "no renderer opens a socket or spawns a process."
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Renderers are pure views (SPEC.md §3). Use the preload-exposed IPC bridge, ' +
                'not electron directly.',
            },
            {
              name: 'better-sqlite3',
              message: 'All persistence happens in the main process (SPEC.md §3).',
            },
            {
              name: 'better-sqlite3-multiple-ciphers',
              message: 'All persistence happens in the main process (SPEC.md §3).',
            },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'child_process', 'net', 'http', 'https'],
              message:
                'Renderers are network- and filesystem-silent (SPEC.md §3). Route it through IPC.',
            },
            {
              group: ['**/main/**'],
              message: 'Renderers must not import main-process code. Share types via src/shared.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Renderers never touch the network (SPEC.md §3).' },
        { name: 'XMLHttpRequest', message: 'Renderers never touch the network (SPEC.md §3).' },
        { name: 'WebSocket', message: 'Renderers never touch the network (SPEC.md §3).' },
        { name: 'EventSource', message: 'Renderers never touch the network (SPEC.md §3).' },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Shared types — imported by both processes, so it may depend on neither
  // ---------------------------------------------------------------------------
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/renderer/**', 'electron'],
              message: 'src/shared is imported by both processes and must stay dependency-free.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Tests — allow the shortcuts that make tests readable
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'no-restricted-imports': 'off',
      // Deliberately still on: an un-awaited assertion is a test that passes for the wrong
      // reason, and SPEC.md §8's security-critical rows are verified by these tests.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // ---------------------------------------------------------------------------
  // Plain JS (config files, scripts) — no type information available
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Must stay last: turns off every rule Prettier owns.
  prettier
);
