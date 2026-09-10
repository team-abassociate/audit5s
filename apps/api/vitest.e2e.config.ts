import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.e2e.test.ts'],
    // Runs in each worker before the test file, which is early enough: the config is
    // parsed when Nest bootstraps inside the harness, not at module import.
    setupFiles: ['./test/setup-env.ts'],
    environment: 'node',
    // One database, one HTTP app: parallel files would fight over both.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
