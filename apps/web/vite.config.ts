/**
 * Vite config for `pnpm --filter @ledgerforce/web dev|build|preview`. The app is served on the
 * API's origin (RQ-0025, DL-0110): in dev, `/auth` and `/t/` are proxied to the API at
 * LF_API_URL (default http://127.0.0.1:3000). JSX uses Vite's built-in transform (DL-0091).
 */
import { defineConfig } from 'vite';

const api = process.env['LF_API_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  server: {
    proxy: {
      '/auth': { target: api },
      '/t/': { target: api },
    },
  },
});
