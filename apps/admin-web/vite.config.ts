import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * A plain SPA. STACK.md §6 rules out SSR for the admin dashboard permanently: it is
 * login-gated, has no SEO to serve and no anonymous first paint to optimise, so server
 * rendering would add a runtime to operate for no benefit.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  /*
   * `strictPort` on purpose: CORS_ORIGINS names http://localhost:5173 exactly, so a
   * silent fallback to 5174 produces an app whose every request is refused by the
   * browser with "Failed to fetch". Better to fail here, loudly, than there.
   */
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: true },
});
