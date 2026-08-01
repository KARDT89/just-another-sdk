import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Root ESLint config, shared by every workspace via `eslint --config ../../eslint.config.mjs`
 * (each package's own `lint` script points here).
 *
 * Layering, from least to most strict:
 *   1. `js.configs.recommended`          — plain JS correctness
 *   2. `tseslint.configs.recommended`    — TS rules that need no type information
 *   3. `recommendedTypeChecked`          — type-aware rules, enabled for `packages/**` only,
 *                                          because they require a tsconfig-resolved program
 *                                          and are slow to run over app/example code.
 *   4. `prettier`                        — last, so it can switch off stylistic conflicts.
 */
export default tseslint.config(
  {
    name: 'jas/ignores',
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.source/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.dist/**',
      '**/*.d.ts',
      // apps/web lints itself with Next's rules — see apps/web/eslint.config.mjs
      'apps/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    name: 'jas/globals',
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
  },

  // Type-aware linting for the published library only.
  //
  // The globs are deliberately cwd-relative-agnostic (`**/src/**` rather than
  // `packages/*/src/**`): ESLint resolves `files` patterns against the working
  // directory, and each package lints itself from its own directory via turbo.
  // A `packages/*`-anchored pattern silently matches nothing there, which would
  // leave the library linted by the weaker untyped rules.
  {
    name: 'jas/library-type-checked',
    files: ['**/src/**/*.ts', '**/test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The SDK deliberately handles `unknown` values coming back from providers
      // and user tool handlers; these two would fire on every such boundary.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Allows the "omit a property" idiom: `const { $schema, ...rest } = x`
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // A `default` branch counts as exhaustive: the SDK's event and error unions
      // are documented as additive, so consumers *should* write a default rather
      // than break when a new member is added.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // Test doubles legitimately break two rules: they mirror `typeof fetch` (so an
  // async signature with no await is required), and they stringify values whose
  // concrete type the test already knows.
  {
    name: 'jas/tests',
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Examples exist to be read and run, so console output is the point.
  {
    name: 'jas/examples',
    files: ['examples/**/*.ts', '**/examples/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Config files run in Node and may use CJS-ish patterns.
  {
    name: 'jas/config-files',
    files: ['**/*.config.{ts,mts,js,mjs}', '**/*.setup.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  prettier,
)
