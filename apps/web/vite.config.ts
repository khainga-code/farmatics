import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { serviceWorker } from './tools/sw.js';

/**
 * The API is proxied in development so the browser sees one origin, which
 * matches how the PWA and API are served in production.
 *
 * A production build bakes VITE_API_URL into the bundle, so a missing or
 * malformed value would ship an app that cannot reach the server. Fail the
 * build instead of deploying it.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = env['VITE_API_URL'];

  if (mode === 'production') {
    if (!apiUrl) {
      throw new Error(
        'VITE_API_URL must be set to the API origin for a production build. ' +
          'Set it in the Cloudflare Build variables or in apps/web/.env.production.',
      );
    }

    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl);
    if (!apiUrl.startsWith('https://') && !isLocal) {
      throw new Error(`VITE_API_URL must be an https origin, got "${apiUrl}".`);
    }

    if (apiUrl.endsWith('/')) {
      throw new Error(
        `VITE_API_URL must not end with a slash, got "${apiUrl}". Requests append /api/v1.`,
      );
    }
  }

  return {
    plugins: [react(), serviceWorker()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  };
});
