import { useEffect, useSyncExternalStore } from 'react';
import type { AppSettings } from '../types';
import { readAppSettings, writeAppSettings } from '../utils/projectCommands';

/**
 * In-memory copy of `{appDataDir}/app_settings.json`, shared by every
 * component in this window. Loaded once; each update is applied here first and
 * written whole, one write at a time, so concurrent edits to different fields
 * can't clobber each other on disk.
 */
let current: AppSettings | null = null;
let loading: Promise<AppSettings> | null = null;
let writeChain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: AppSettings) {
  current = next;
  listeners.forEach(l => l());
}

/** The settings, loading them on first call. A failed read counts as empty. */
export function loadAppSettings(): Promise<AppSettings> {
  if (current) return Promise.resolve(current);
  loading ??= readAppSettings()
    .catch(err => { console.error('Failed to read app settings:', err); return {} as AppSettings; })
    .then(s => { if (!current) publish(s ?? {}); return current!; });
  return loading;
}

/** Apply `update` to the settings and persist the result. */
export async function updateAppSettings(update: (prev: AppSettings) => AppSettings): Promise<AppSettings> {
  await loadAppSettings();
  // Read `current` after the await: another update may have landed meanwhile.
  const next = update(current!);
  publish(next);
  writeChain = writeChain
    .then(() => writeAppSettings(next))
    .catch(err => console.error('Failed to write app settings:', err));
  await writeChain;
  return next;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The current settings, or null until they've loaded. */
export function useAppSettings(): AppSettings | null {
  const settings = useSyncExternalStore(subscribe, () => current);
  useEffect(() => { loadAppSettings(); }, []);
  return settings;
}
