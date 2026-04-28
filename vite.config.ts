import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  clearScreen: false,
  server: {
    port: 3000,
    host: '0.0.0.0',
    strictPort: true,
  },
  plugins: [react()],
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      '@': '.',
    }
  }
});