import { useState, useEffect, useRef, useCallback } from 'react';
import { RecentFileEntry } from '../types';
import { getAppDataDir, loadRecentFiles, saveRecentFiles } from '../utils/projectCommands';
import { registryFilePath } from '../utils/projectPaths';

/** Mirrors useProjects' registry pattern for single files opened outside a project. */
export function useRecentFiles() {
  const [entries, setEntries] = useState<RecentFileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const filesFileRef = useRef<string | null>(null);
  const entriesRef = useRef<RecentFileEntry[]>([]);
  // Settles once the registry has been read. Every mutation waits on it: an
  // "Open With SeeNote" cold start records its file before the read finishes,
  // and would otherwise be dropped (no path to save to yet) and then
  // overwritten by the loaded list.
  const readyRef = useRef<Promise<void> | null>(null);

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
    readyRef.current = (async () => {
      try {
        const appDataDir = await getAppDataDir();
        const filePath = registryFilePath(appDataDir, 'files.json');
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

  const whenReady = useCallback(() => readyRef.current ?? Promise.resolve(), []);

  /** Record a file as just-opened: move it to front, or add it if new. */
  const touchRecentFile = useCallback(async (path: string): Promise<void> => {
    await whenReady();
    const now = new Date().toISOString();
    const existing = entriesRef.current.find(e => e.path === path);
    const entry: RecentFileEntry = existing
      ? { ...existing, lastOpened: now }
      : { id: crypto.randomUUID(), path, lastOpened: now };
    const next = [entry, ...entriesRef.current.filter(e => e.path !== path)];
    setBoth(next);
    await persist(next);
  }, [persist, setBoth, whenReady]);

  /** The registry entry for `path`, once the registry has loaded. */
  const getRecentFile = useCallback(async (path: string): Promise<RecentFileEntry | undefined> => {
    await whenReady();
    return entriesRef.current.find(e => e.path === path);
  }, [whenReady]);

  /** Remember (or, with null, forget) the buzzdetect CSV imported for `path`. */
  const setRecentFileBuzzdetect = useCallback(async (path: string, buzzdetectFile: string | null): Promise<void> => {
    await whenReady();
    const existing = entriesRef.current.find(e => e.path === path);
    if (!existing || (existing.buzzdetectFile ?? null) === buzzdetectFile) return;
    const next = entriesRef.current.map(e =>
      e.path === path ? { ...e, buzzdetectFile: buzzdetectFile ?? undefined } : e
    );
    setBoth(next);
    await persist(next);
  }, [persist, setBoth, whenReady]);

  const removeRecentFile = useCallback(async (id: string): Promise<void> => {
    const next = entriesRef.current.filter(e => e.id !== id);
    setBoth(next);
    await persist(next);
  }, [persist, setBoth]);

  const toggleFileStarred = useCallback(async (id: string): Promise<void> => {
    const next = entriesRef.current.map(e =>
      e.id === id ? { ...e, starred: !e.starred } : e
    );
    setBoth(next);
    await persist(next);
  }, [persist, setBoth]);

  return {
    fileEntries: entries,
    isLoadingFiles: isLoading,
    touchRecentFile,
    getRecentFile,
    setRecentFileBuzzdetect,
    removeRecentFile,
    toggleFileStarred,
  };
}
