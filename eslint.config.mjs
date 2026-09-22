// Flat ESLint config for the whole workspace.
//
// The rules that matter here are not style rules. AZ-1 (ARCHITECTURE.md §6.1, restated by
// DECISIONS.md R-1) says no repository method may execute without a scope predicate, and
// that constructing a Drizzle query outside a repository class is forbidden. That is
// enforced below by `no-restricted-syntax`, not by review.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/** Drizzle query builders. Calling these outside a repository bypasses ScopeContext. */
const DRIZZLE_QUERY_ENTRYPOINTS = ['select', 'insert', 'update', 'delete', 'execute'];

const drizzleOutsideRepository = DRIZZLE_QUERY_ENTRYPOINTS.map((method) => ({
  selector: `CallExpression[callee.property.name='${method}'][callee.object.name=/^(db|tx|database)$/]`,
  message:
    `AZ-1: '${method}()' may only be constructed inside a *.repository.ts class, which requires ` +
    'an explicit ScopeContext. Move this query into a repository.',
}));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.expo/**', '**/android/**', '**/ios/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error', ...drizzleOutsideRepository],
      // The host do-not-touch list (STACK.md §6). CI greps as well; this catches it earlier.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['oci-*', '@oracle/*', 'hostinger*', '@hostinger/*'],
              message:
                'STACK.md §6: the host do-not-touch list — application code never names the hosting provider.',
            },
          ],
        },
      ],
    },
  },
  {
    // Repositories are the one place a Drizzle query may be built.
    files: ['**/*.repository.ts', '**/repositories/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // NestJS resolves constructor dependencies from `design:paramtypes`, which TypeScript
    // only emits for imports that survive as *values*. `consistent-type-imports` would
    // rewrite an injected class to `import type`, erasing it and leaving the container
    // with `undefined` at runtime — a failure that typechecks cleanly and only shows up on
    // boot. The rule stays on everywhere else.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // packages/db owns the schema and the migration runner.
    files: ['packages/db/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
  {
    // Tests, the seed and the smoke script are console programs; their output is the point.
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test/**/*.ts',
      '**/seed.ts',
      '**/smoke*.mjs',
    ],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
  {
    // Expo config plugins. Expo's own resolver `require()`s these at prebuild time, before
    // any bundler or TypeScript pipeline exists, so they are CommonJS by obligation rather
    // than by choice. The rule stays on for every other file in the workspace.
    files: ['apps/field-mobile/plugins/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
