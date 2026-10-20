import { useState, useEffect, useCallback, useRef } from 'react';
import { LoadedAnnotations, Project } from '../types';
import { syncProject, pullProject, getLocalSyncStatus, fetchRemoteStatus, type SyncSummary } from '../utils/tauriCommands';
import { readSyncToken } from '../utils/gitSync';
import { persistAnnotations, resolveFlushTarget, whenWritesSettled } from '../utils/annotationPersist';
import type { AnnotationIoGate } from '../utils/annotationIoGate';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_AUTO_PULL_REMOTE_CHANGES } from '../constants';
import { resolveAnnotatorName } from '../utils/appSettings';
import { loadAppSettings } from './useAppSettings';

/** Commit author for a sync: the app-wide name, else the project's legacy one. */
async function annotatorName(project: Project): Promise<string> {
  return resolveAnnotatorName(await loadAppSettings(), project.preferences.gitSyncUser?.authorName);
}

/** Prefix of the error an auto-pull returns instead of applying a remote clear
 *  (mirrors INCOMING_CLEARS_PREFIX in git_sync/mod.rs). */
export const INCOMING_CLEARS_PREFIX = 'INCOMING_CLEARS:';

/** Sync errors the user has to act on, as opposed to a transient network failure. */
export function needsUserAction(message: string): boolean {
  return message.includes('AUTH_FAILED:')
    || message.includes(INCOMING_CLEARS_PREFIX)
    || message.includes('refusing to sync');
}

interface UseSyncManagementArgs {
  project: Project;
  projectRef: React.MutableRefObject<Project>;
  // Resolves a track's on-disk annotation path; used to flush the pending save.
  getAnnotationPath: (trackFilePath: string) => string | null;
  // Pending autosave timer; cleared so the in-flight debounce can't fire after sync.
  autoSaveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  trackPathRef: React.MutableRefObject<string | null>;
  // Track + that track's annotations, as one atomic value (see
  // LoadedAnnotations in types.ts). The flush reads the path AND the list from
  // here, so it can't pair a real track with the transient empty state from a
  // track switch — persisting that pairing is what deleted real annotation files.
  loadedAnnotationsRef: React.MutableRefObject<LoadedAnnotations | null>;
  // Counts a running sync (and the reload after it) as work a track switch must
  // wait out. See utils/annotationIoGate.ts.
  ioGate: AnnotationIoGate;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

// Owns git-sync state, the manual sync handler, the mount-time local-status
// check, and the 2-minute remote heartbeat. `setHasLocalChanges` is returned so
// the annotation autosave effect (which stays in AnnotationWindow) can mark the
// repo dirty after a write. `reloadNonce` is consumed by the annotation
// auto-load effect (also still in AnnotationWindow) to re-read disk after a pull.
export function useSyncManagement({
  project,
  projectRef,
  getAnnotationPath,
  autoSaveTimeoutRef,
  trackPathRef,
  loadedAnnotationsRef,
  ioGate,
  addLog,
}: UseSyncManagementArgs) {
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  // True when `syncSummary` came from a background auto-pull rather than the
  // manual Sync button — the toast uses this to pick its title.
  const [syncIsAutoPull, setSyncIsAutoPull] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const [hasRemoteChanges, setHasRemoteChanges] = useState(false);
  // Bumped after a pull (or a manual refresh) so the auto-load effect re-reads
  // the active track's annotation file, which may have changed on disk.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Exposed so a manual "refresh" action can force the same re-read a pull
  // triggers, without pretending a sync actually happened.
  // Every reload request also tells the gate, so a track switch waits for the
  // reload effect (which may not have run yet) instead of racing past it.
  const requestReload = useCallback(() => {
    ioGate.requestReload();
    setReloadNonce(n => n + 1);
  }, [ioGate]);
  const bumpReloadNonce = requestReload;

  // The commit message the last sync ran with, so confirming a pending clear
  // re-runs the same sync rather than silently dropping a typed message.
  const lastCommitMessageRef = useRef('');

  const syncGateEndRef = useRef<(() => void) | null>(null);
  const setSyncingBoth = useCallback((v: boolean) => {
    syncingRef.current = v;
    setSyncing(v);
    if (v) {
      syncGateEndRef.current?.();
      syncGateEndRef.current = ioGate.begin();
    } else {
      syncGateEndRef.current?.();
      syncGateEndRef.current = null;
    }
  }, [ioGate]);

  // Write the pending debounced autosave (if any) right now. Used by the sync
  // paths themselves, which already own the "sync running" state.
  // Also waits for writes already in flight, so a sync never stages a file an
  // earlier autosave is still writing.
  const flushNow = useCallback(async () => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = null;
      // The track AND the list come from one read of the snapshot — see
      // resolveFlushTarget for why pairing them from separate refs deleted files.
      const target = resolveFlushTarget(loadedAnnotationsRef.current, trackPathRef.current, getAnnotationPath);
      if (target) {
        await persistAnnotations(target.annotPath, target.annotations, projectRef.current.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS);
      }
    }
    await whenWritesSettled();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAnnotationPath]);

  // Flush for callers that are about to leave the track (track switch, media
  // directory change). With an edit pending, waits out any running sync and
  // the reload after it first: writing during a sync is reverted by its forced
  // checkout, and leaving before the post-pull reload merges would drop the
  // edit that merge exists to keep. With nothing pending there is nothing to
  // lose, so a track switch never stalls behind a background pull.
  // Returns only once nothing is pending, so a caller that wipes annotation
  // state right after the await can't drop an edit made while it waited.
  const flushPendingAutosave = useCallback(async () => {
    for (let i = 0; i < 5; i++) {
      if (autoSaveTimeoutRef.current) {
        await ioGate.settle();
        await flushNow();
      } else {
        await whenWritesSettled();
      }
      if (!autoSaveTimeoutRef.current) return;
    }
  }, [ioGate, flushNow, autoSaveTimeoutRef]);

  // Sync annotations to/from the configured GitHub repo. Flushes any pending
  // autosave first so local edits aren't lost, runs the embedded-git pipeline,
  // then reloads the active track if the pull changed anything on disk.
  const handleSync = useCallback(async (commitMessage = '', confirmedClears: string[] = []) => {
    const cfg = projectRef.current.settings.gitSync;
    if (!cfg?.remoteUrl) {
      setSyncError('Configure the repository URL under Project Settings → Sync first.');
      setSyncSummary(null);
      return;
    }
    const annDir = projectRef.current.annotationDirectoryAbs;
    if (!annDir) {
      setSyncError('No annotation directory configured for this project.');
      return;
    }
    if (syncingRef.current) return; // an auto-pull (or another sync) is already running
    setSyncingBoth(true);
    setSyncError(null);
    setSyncSummary(null);
    setSyncIsAutoPull(false);
    lastCommitMessageRef.current = commitMessage;
    try {
      await flushNow();
      const token = await readSyncToken(cfg.remoteUrl, projectRef.current.preferences.gitSyncUser ?? {});
      if (!token) {
        setSyncError('No access token found for this repository. Open Project Settings → Sync to enter your PAT.');
        setSyncingBoth(false);
        return;
      }
      const summary = await syncProject(
        projectRef.current.projectDir,
        annDir,
        cfg.remoteUrl,
        token,
        await annotatorName(projectRef.current),
        commitMessage,
        confirmedClears,
      );
      setSyncSummary(summary);
      addLog(
        `Sync: ${summary.message}` +
        (summary.annotationsAdded > 0 || summary.annotationsRemoved > 0
          ? ` downloaded +${summary.annotationsAdded}/-${summary.annotationsRemoved} across ${summary.recordingsChanged.length} file(s)` : '') +
        (summary.identsUploaded > 0
          ? ` uploaded +${summary.annotationsUploaded}/-${summary.annotationsRemovedOnPush} across ${summary.identsUploaded} file(s)` : '')
      );
      if (summary.pulled) requestReload();
      setHasLocalChanges(false);
      setHasRemoteChanges(false);
    } catch (err) {
      setSyncError(String(err));
      addLog(`Sync failed: ${err}`, 'error');
    } finally {
      setSyncingBoth(false);
    }
  }, [flushNow, addLog, setSyncingBoth, requestReload]);

  // The user answered "yes, commit these clears": re-run the same sync with the
  // idents confirmed, so staging is allowed to commit those empty files.
  const confirmPendingClears = useCallback(async (idents: string[]) => {
    if (idents.length === 0) return;
    await handleSync(lastCommitMessageRef.current, idents);
  }, [handleSync]);

  // Pull remote annotation changes in (fetch + merge, never push) for the
  // background auto-pull — on project open and the heartbeat below. A failure
  // that needs the user (bad token, a refused remote clear, the missing-folder
  // guard) is shown like a manual sync error; transient ones (offline) are
  // only logged, since this retries every two minutes.
  const handleAutoPull = useCallback(async () => {
    const cfg = projectRef.current.settings.gitSync;
    const annDir = projectRef.current.annotationDirectoryAbs;
    if (!cfg?.remoteUrl || !annDir) return;
    if (!(projectRef.current.preferences.autoPullRemoteChanges ?? DEFAULT_AUTO_PULL_REMOTE_CHANGES)) return;
    if (syncingRef.current) return; // a manual sync is already running
    // Claim the sync slot before the first await: with the token read first, a
    // manual Sync clicked in that gap ran concurrently with this pull.
    setSyncingBoth(true);
    try {
      const token = await readSyncToken(cfg.remoteUrl, projectRef.current.preferences.gitSyncUser ?? {});
      if (!token) return;
      await flushNow();
      const summary = await pullProject(
        projectRef.current.projectDir,
        annDir,
        cfg.remoteUrl,
        token,
        await annotatorName(projectRef.current),
      );
      if (summary.pulled) {
        requestReload();
        setSyncIsAutoPull(true);
        setSyncSummary(summary);
        addLog(
          `Auto-pull: downloaded +${summary.annotationsAdded}/-${summary.annotationsRemoved} across ${summary.recordingsChanged.length} file(s)`
        );
      }
      const status = await getLocalSyncStatus(projectRef.current.projectDir, annDir);
      setHasLocalChanges(status.hasLocalChanges);
      setHasRemoteChanges(status.hasRemoteChanges);
    } catch (err) {
      const msg = String(err);
      addLog(`Auto-pull failed: ${msg}`, 'error');
      if (needsUserAction(msg)) {
        setSyncIsAutoPull(true);
        setSyncError(msg);
      }
    } finally {
      setSyncingBoth(false);
    }
  }, [flushNow, addLog, setSyncingBoth, requestReload]);

  // On project load: check local-only sync status, then kick off an
  // auto-pull (no-op if disabled, unconfigured, or no token yet) so the
  // project is caught up before the user starts editing.
  useEffect(() => {
    const cfg = project.settings.gitSync;
    const annDir = project.annotationDirectoryAbs;
    if (!cfg?.remoteUrl || !annDir) return;
    getLocalSyncStatus(project.projectDir, annDir)
      .then(status => {
        setHasLocalChanges(status.hasLocalChanges);
        setHasRemoteChanges(status.hasRemoteChanges);
      })
      .catch(() => {})
      .finally(() => { handleAutoPull(); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.projectDir]);

  // Heartbeat (every 2 minutes): auto-pull when enabled, so it both merges in
  // remote changes and refreshes the status dots; otherwise fall back to a
  // status-only fetch so the "remote changed" dot still lights up.
  useEffect(() => {
    const cfg = project.settings.gitSync;
    if (!cfg?.remoteUrl) return;
    const dir = project.projectDir;
    const url = cfg.remoteUrl;
    const id = setInterval(async () => {
      if (project.preferences.autoPullRemoteChanges ?? DEFAULT_AUTO_PULL_REMOTE_CHANGES) {
        await handleAutoPull();
        return;
      }
      try {
        const tok = await readSyncToken(cfg.remoteUrl, project.preferences.gitSyncUser ?? {});
        if (!tok) return;
        const ahead = await fetchRemoteStatus(dir, url, tok);
        setHasRemoteChanges(ahead);
      } catch {
        // silently ignore heartbeat failures
      }
    }, 2 * 60 * 1000);
    return () => clearInterval(id);
  }, [project.projectDir, project.settings.gitSync?.remoteUrl, project.preferences.autoPullRemoteChanges, handleAutoPull]);

  return {
    syncing,
    // Exposed so the autosave effect (useAnnotationLoad) can suspend disk writes
    // while a sync/merge/checkout is in flight.
    syncingRef,
    syncSummary,
    setSyncSummary,
    syncIsAutoPull,
    syncError,
    setSyncError,
    hasLocalChanges,
    setHasLocalChanges,
    hasRemoteChanges,
    reloadNonce,
    bumpReloadNonce,
    handleSync,
    confirmPendingClears,
    flushPendingAutosave,
  };
}
