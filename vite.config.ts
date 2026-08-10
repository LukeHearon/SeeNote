import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { version } from './package.json';

export default defineConfig({
  base: '/',
  clearScreen: false,
  // Inlined at build time so the running version is legible without an IPC
  // round-trip — a failed `get_diagnostic_info` must not be able to hide it.
  // `npm version` keeps package.json in step with tauri.conf.json and Cargo.toml.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
  plugins: [react()],
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      '@': '.',
    }
  }
});