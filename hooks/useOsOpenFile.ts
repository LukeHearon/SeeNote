import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { takePendingOpenFile } from '../utils/tauriCommands';

/**
 * Routes an OS-level "Open With SeeNote" launch into the app. Covers two
 * cases the Rust side (see src-tauri/src/lib.rs) can hand us a path through:
 *  - Cold start (fileAssociations launch, or Windows/Linux CLI arg): the path
 *    may arrive before this listener is attached, so it's stashed on the Rust
 *    side and drained once via `take_pending_open_file` on mount.
 *  - SeeNote already running: tauri-plugin-single-instance forwards the
 *    second launch's path here as a live `open-file` event instead of
 *    spawning a duplicate window.
 */
export function useOsOpenFile(onOpenFile: (path: string) => void) {
  useEffect(() => {
    let cancelled = false;

    takePendingOpenFile()
      .then(path => { if (!cancelled && path) onOpenFile(path); })
      .catch(err => console.error('Failed to check for pending open-file:', err));

    const unlistenPromise = listen<string>('open-file', event => onOpenFile(event.payload));

    return () => {
      cancelled = true;
      unlistenPromise.then(unlisten => unlisten()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
