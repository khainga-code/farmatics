import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The API is proxied in development so the browser sees one origin, which
 * matches how the PWA and API are served in production.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
