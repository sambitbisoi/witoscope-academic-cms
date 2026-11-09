import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev only: /api goes to the local file service (npm run dev:files), and the local
// Access token is added here, as Cloudflare Access does in production.
const tokenFile = resolve(__dirname, '..', '.dev-access', 'token');
const devToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null;

// Port 5199 so it never collides with the witoscope-app dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8790',
        ...(devToken ? { headers: { 'cf-access-jwt-assertion': devToken } } : {}),
      },
    },
  },
});
