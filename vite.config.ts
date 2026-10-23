import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // ShopBook is published to GitHub Pages under the /ShopBook/ subpath
  // (https://arabninja-hub.github.io/ShopBook/). Prefixing asset URLs with
  // this base keeps the bundled JS/CSS and public assets resolvable; without
  // it they resolve against the domain root and 404 (the blank-page bug).
  base: '/ShopBook/',
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
