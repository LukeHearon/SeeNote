import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      '@': path.resolve(__dirname, '.'),
    }
  }
});