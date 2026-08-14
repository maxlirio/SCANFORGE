import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// getUserMedia only works on https or localhost. Scanning with a phone means
// hitting this dev server over the LAN, so HTTPS is on by default; set
// SCANFORGE_HTTPS=0 if you only ever use localhost.
const useHttps = process.env.SCANFORGE_HTTPS !== '0';

// GitHub Pages serves the app from /<repo>/, a normal server from /.
const base = process.env.SCANFORGE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.SCANFORGE_API ?? 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
