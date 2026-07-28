import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('Tauri invoke unavailable in tests'))),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  // Channel is constructed by the spectrogram range command. The real one
  // registers a callback with the Tauri runtime; here it only needs to exist so
  // module import and construction don't throw.
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));
