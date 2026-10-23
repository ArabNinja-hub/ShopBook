import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Public path the built app is served from.
 *
 * - Render / any single-origin host serves the app at `/`      -> VITE_BASE_PATH unset (default `/`)
 * - GitHub Pages project sites serve it at `/ShopBook/`        -> VITE_BASE_PATH=/ShopBook/
 *
 * Keeping this environment-driven (instead of hardcoding `/ShopBook/`) is what keeps
 * `server/app.ts` static serving on Render working. See `scripts/verify-dist-base.mjs`,
 * which fails the build if the emitted HTML contains asset paths that escape the base.
 */
function normalizeBase(rawBase: string | undefined): string {
  const trimmed = (rawBase ?? '').trim();
  if (!trimmed || trimmed === '/') return '/';

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/')
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

const base = normalizeBase(process.env.VITE_BASE_PATH);

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
        xfwd: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
        xfwd: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    maxWorkers: 2,
  },
});
