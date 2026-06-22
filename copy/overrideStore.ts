import { useEffect, useReducer } from 'react';

const STORAGE_KEY = 'copy:overrides';

export const copyChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('copy-editor') : null;

function readFromStorage(): Record<string, string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

let _overrides: Record<string, string> = readFromStorage();
let _listeners: Array<() => void> = [];
let _accessed = new Set<string>();
let _skipRecording = false;
let _skipOverrides = false;

copyChannel?.addEventListener('message', (e) => {
  if (e.data?.type === 'overrides') {
    _overrides = e.data.overrides as Record<string, string>;
    _listeners.forEach(l => l());
  }
});

function persist(overrides: Record<string, string>) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch { /* ignore */ }
  copyChannel?.postMessage({ type: 'overrides', overrides });
}

export function getOverride(key: string): string | undefined {
  if (!_skipRecording) _accessed.add(key);
  if (_skipOverrides) return undefined;
  return _overrides[key];
}

export function getAccessedKeys(): Set<string> {
  return _accessed;
}

export function withoutRecording<T>(fn: () => T): T {
  _skipRecording = true;
  try { return fn(); } finally { _skipRecording = false; }
}

export function withoutOverrides<T>(fn: () => T): T {
  _skipOverrides = true;
  try { return fn(); } finally { _skipOverrides = false; }
}

export function setOverride(key: string, value: string) {
  _overrides = { ..._overrides, [key]: value };
  persist(_overrides);
  _listeners.forEach(l => l());
}

export function clearOverrides() {
  _overrides = {};
  persist(_overrides);
  _listeners.forEach(l => l());
}

export function getAllOverrides(): Record<string, string> {
  return _overrides;
}

export function useCopyRerenderOnChange() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    _listeners.push(bump);
    return () => { _listeners = _listeners.filter(l => l !== bump); };
  }, []);
}
