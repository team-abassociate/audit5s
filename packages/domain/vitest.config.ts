import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // STACK.md §7 step 2: packages/domain carries a 90% coverage target.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
