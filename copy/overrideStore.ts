import { useEffect, useReducer } from 'react';

let _overrides: Record<string, string> = {};
let _listeners: Array<() => void> = [];
let _accessed = new Set<string>();
let _skipRecording = false;

export function getOverride(key: string): string | undefined {
  if (!_skipRecording) _accessed.add(key);
  return _overrides[key];
}

export function getAccessedKeys(): Set<string> {
  return _accessed;
}

export function withoutRecording<T>(fn: () => T): T {
  _skipRecording = true;
  try { return fn(); } finally { _skipRecording = false; }
}

export function setOverride(key: string, value: string) {
  _overrides = { ..._overrides, [key]: value };
  _listeners.forEach(l => l());
}

export function clearOverrides() {
  _overrides = {};
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
