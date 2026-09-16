import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * HTTPS on the LAN, when `infra/.local/certs` holds a certificate (see the runbook).
 *
 * A corrective-action page needs a **secure context** or the browser refuses the camera, and
 * an address like `https://192.168.0.123:5173` is the only way to get one on a Wi-Fi with no
 * public hostname. The certificate is signed by a local authority each test phone installs
 * once. Absent the files this is plain HTTP, so a fresh checkout still runs.
 */
const certificates = resolve(__dirname, '../../infra/.local/certs');
const https = existsSync(resolve(certificates, 'server-cert.pem'))
  ? {
      key: readFileSync(resolve(certificates, 'server-key.pem')),
      cert: readFileSync(resolve(certificates, 'server-cert.pem')),
    }
  : undefined;

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
  server: {
    port: 5173,
    strictPort: true,
    /*
     * A corrective-action link is opened on a Zone Leader's phone, through a Cloudflare
     * quick tunnel to this server (`cloudflared tunnel --url http://localhost:5173`). Vite
     * refuses a Host it does not know, so the tunnel's domain is let in, and `/api` is
     * passed to the API on the same origin — the page then needs no second public address
     * for the API. 127.0.0.1, not localhost: Node resolves localhost to ::1 first, and the
     * API listens on IPv4.
     */
    /*
     * Also served on the LAN, so a phone on the same Wi-Fi can open a corrective-action
     * link without a tunnel. A `http://192.168.x.x` page is not a secure context, so the
     * camera needs Chrome's "Insecure origins treated as secure" for that one origin —
     * a per-device testing setting, not something a real deployment relies on.
     */
    host: true,
    https,
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
