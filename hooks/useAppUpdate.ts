import { useEffect, useState } from 'react';
import { checkForUpdate, installUpdate, isUpdateSupported, openReleasesPage, UpdateInfo } from '../utils/tauriCommands';

const RELEASES_URL = 'https://github.com/LukeHearon/SeeNote/releases/latest';

type UpdateState = 'idle' | 'installing' | 'error';

/**
 * Checks the GitHub releases updater manifest once on mount. `supported` is
 * false on a Linux .deb install — the updater can only swap in an AppImage in
 * place, so those users are pointed at the releases page instead of getting
 * an "Update" button. See src-tauri/src/commands/updater.rs.
 */
export function useAppUpdate() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [supported, setSupported] = useState(true);
  const [state, setState] = useState<UpdateState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    isUpdateSupported().then(v => { if (!cancelled) setSupported(v); }).catch(() => {});
    checkForUpdate().then(v => { if (!cancelled) setUpdate(v); }).catch(err => console.error('Update check failed:', err));
    return () => { cancelled = true; };
  }, []);

  const applyUpdate = async () => {
    setState('installing');
    setError(null);
    try {
      // Resolves only on failure — a successful install restarts the app.
      await installUpdate();
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const viewRelease = () => {
    openReleasesPage(RELEASES_URL).catch(err => console.error('Failed to open releases page:', err));
  };

  return { update, supported, state, error, applyUpdate, viewRelease };
}
