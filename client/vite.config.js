import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev the React app runs on :5173 and the API/WebSocket on :3001.
// These proxies let the frontend call /api, /uploads and /socket.io as if
// same-origin. Override the backend with VITE_API_TARGET to point a dev client
// at a different server (a second instance, or another machine on your LAN).
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/uploads': { target: API_TARGET, changeOrigin: true },
      '/maps': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, ws: true },
    },
  },
});
