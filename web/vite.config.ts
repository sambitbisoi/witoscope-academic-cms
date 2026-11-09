import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Port 5199 so it never collides with the witoscope-app dev server.
export default defineConfig({ plugins: [react()], server: { port: 5199, strictPort: true } });
