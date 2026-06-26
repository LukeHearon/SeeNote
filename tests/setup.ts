import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('Tauri invoke unavailable in tests'))),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));
