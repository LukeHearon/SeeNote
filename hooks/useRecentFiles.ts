import { useState, useEffect, useRef, useCallback } from 'react';
import { RecentFileEntry } from '../types';
import { getAppDataDir, loadRecentFiles, saveRecentFiles } from '../utils/projectCommands';

function getFilesFilePath(appDataDir: string): string {
  const base = appDataDir.replace(/[/\\]+$/, '');
  return base + '/.projects/files.json';
}

/** Mirrors useProjects' registry pattern for single files opened outside a project. */
export function useRecentFiles() {
  const [entries, setEntries] = useState<RecentFileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const filesFileRef = useRef<string | null>(null);
  const entriesRef = useRef<RecentFileEntry[]>([]);

  const setBoth = useCallback((next: RecentFileEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const persist = useCallback(async (next: RecentFileEntry[]) => {
    if (!filesFileRef.current) {
      console.error('persist called before filesFileRef was set');
      return;
    }
    try {
      await saveRecentFiles(filesFileRef.current, next);
    } catch (err) {
      console.error('Failed to save recent files registry:', err);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const appDataDir = await getAppDataDir();
        const filePath = getFilesFilePath(appDataDir);
        filesFileRef.current = filePath;
        const loaded = await loadRecentFiles(filePath);
        loaded.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
        setBoth(loaded);
      } catch (err) {
        console.error('Failed to load recent files registry:', err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [setBoth]);

  /** Record a file as just-opened: move it to front, or add it if new. */
  const touchRecentFile = useCallback(async (path: string): Promise<void> => {
    const now = new Date().toISOString();
    const existing = entriesRef.current.find(e => e.path === path);
    const entry: RecentFileEntry = existing
      ? { ...existing, lastOpened: now }
      : { id: crypto.randomUUID(), path, lastOpened: now };
    const next = [entry, ...entriesRef.current.filter(e => e.path !== path)];
    setBoth(next);
    await persist(next);
  }, [persist, setBoth]);

  const removeRecentFile = useCallback(async (id: string): Promise<void> => {
    const next = entriesRef.current.filter(e => e.id !== id);
    setBoth(next);
    await persist(next);
  }, [persist, setBoth]);

  return { fileEntries: entries, isLoadingFiles: isLoading, touchRecentFile, removeRecentFile };
}
