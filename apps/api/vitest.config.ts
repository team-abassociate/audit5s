import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * SWC rather than esbuild, because NestJS resolves constructor dependencies from
 * `design:paramtypes` and esbuild does not emit decorator metadata at all — under it every
 * injected dependency arrives as `undefined`.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
