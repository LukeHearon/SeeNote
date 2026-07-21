import { useState, useEffect, useCallback, useRef } from 'react';
import { Annotation, Project } from '../types';
import { syncProject, pullProject, getLocalSyncStatus, fetchRemoteStatus, type SyncSummary } from '../utils/tauriCommands';
import { readSyncToken } from '../utils/gitSync';
import { persistAnnotations } from '../utils/annotationPersist';
import { generateAudacityContent } from '../utils/helpers';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_AUTO_PULL_REMOTE_CHANGES } from '../constants';

// The exact annotation state flushed/committed at sync start, used as the
// three-way-merge ancestor when the post-pull reload re-reads disk. Shared with
// useAnnotationLoad, which consumes and clears it. See utils/annotationMerge.ts.
export interface PreSyncSnapshot {
  trackPath: string | null;
  content: string;
}

interface UseSyncManagementArgs {
  project: Project;
  projectRef: React.MutableRefObject<Project>;
  // Live annotation list — flushed to disk before the sync runs.
  annotations: Annotation[];
  // Resolves a track's on-disk annotation path; used to flush the pending save.
  getAnnotationPath: (trackFilePath: string) => string | null;
  // Pending autosave timer; cleared so the in-flight debounce can't fire after sync.
  autoSaveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  trackPathRef: React.MutableRefObject<string | null>;
  // Which track's annotations have finished loading from disk (owned by
  // useAnnotationLoad). The flush must never persist before this matches the
  // current track — `annotations` would be the transient empty state from a
  // track switch, and persisting it truncated real annotation files.
  loadedAnnotationTrackRef: React.MutableRefObject<string | null>;
  // Ancestor snapshot for the post-pull three-way merge. Written here at sync
  // start (right after the flush); read and cleared by useAnnotationLoad.
  preSyncSnapshotRef: React.MutableRefObject<PreSyncSnapshot | null>;
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
  annotations,
  getAnnotationPath,
  autoSaveTimeoutRef,
  trackPathRef,
  loadedAnnotationTrackRef,
  preSyncSnapshotRef,
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
  // Bumped after a pull so the auto-load effect re-reads the active track's
  // annotation file (which may have changed on disk during the merge).
  const [reloadNonce, setReloadNonce] = useState(0);

  const setSyncingBoth = useCallback((v: boolean) => {
    syncingRef.current = v;
    setSyncing(v);
  }, []);

  // Flush a pending debounced autosave so in-flight edits are committed to
  // disk before a sync/pull runs. Shared by handleSync and the auto-pull path.
  const flushPendingAutosave = useCallback(async () => {
    if (!autoSaveTimeoutRef.current) return;
    clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = null;
    const trackPath = trackPathRef.current;
    // Persist only state that reflects a completed load of the current track;
    // otherwise `annotations` may be the empty placeholder from a track switch.
    if (!trackPath || loadedAnnotationTrackRef.current !== trackPath) return;
    const annotPath = getAnnotationPath(trackPath);
    if (!annotPath) return;
    await persistAnnotations(annotPath, annotations, project.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, getAnnotationPath, project.settings.outputRoundingDecimals]);

  // Capture the just-flushed state as the merge ancestor: the exact content the
  // post-pull reload will diff current in-memory + disk against, so an edit made
  // while the sync ran is folded back in rather than clobbered by the checkout.
  const snapshotMergeAncestor = useCallback(() => {
    const trackPath = trackPathRef.current;
    // Only capture a hydrated track: if the sync starts mid-load, `annotations`
    // is the transient [] — an empty ancestor would make the reload-merge union
    // everything and resurrect remote-deleted lines. With no snapshot the
    // reload blind-replaces from disk, which is correct (no user edits exist).
    if (!trackPath || loadedAnnotationTrackRef.current !== trackPath) {
      preSyncSnapshotRef.current = null;
      return;
    }
    const decimals = projectRef.current.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
    preSyncSnapshotRef.current = {
      trackPath,
      content: generateAudacityContent(annotations, decimals),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations]);

  // Sync annotations to/from the configured GitHub repo. Flushes any pending
  // autosave first so local edits aren't lost, runs the embedded-git pipeline,
  // then reloads the active track if the pull changed anything on disk.
  const handleSync = useCallback(async (commitMessage = '') => {
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
    try {
      await flushPendingAutosave();
      snapshotMergeAncestor();
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
        projectRef.current.preferences.gitSyncUser?.authorName ?? '',
        commitMessage,
      );
      setSyncSummary(summary);
      addLog(
        `Sync: ${summary.message}` +
        (summary.annotationsAdded > 0 || summary.annotationsRemoved > 0
          ? ` downloaded +${summary.annotationsAdded}/-${summary.annotationsRemoved} across ${summary.recordingsChanged.length} file(s)` : '') +
        (summary.identsUploaded > 0
          ? ` uploaded +${summary.annotationsUploaded} across ${summary.identsUploaded} file(s)` : '')
      );
      if (summary.pulled) setReloadNonce(n => n + 1);
      setHasLocalChanges(false);
      setHasRemoteChanges(false);
    } catch (err) {
      setSyncError(String(err));
      addLog(`Sync failed: ${err}`, 'error');
    } finally {
      setSyncingBoth(false);
    }
  }, [flushPendingAutosave, snapshotMergeAncestor, addLog, setSyncingBoth]);

  // Pull remote annotation changes in (fetch + merge, never push) for the
  // background auto-pull — on project open and the heartbeat below. Silent on
  // failure (no user-visible error): this runs unattended, and the manual
  // Sync button remains the place to see and resolve real problems.
  const handleAutoPull = useCallback(async () => {
    const cfg = projectRef.current.settings.gitSync;
    const annDir = projectRef.current.annotationDirectoryAbs;
    if (!cfg?.remoteUrl || !annDir) return;
    if (!(projectRef.current.preferences.autoPullRemoteChanges ?? DEFAULT_AUTO_PULL_REMOTE_CHANGES)) return;
    if (syncingRef.current) return; // a manual sync is already running
    try {
      const token = await readSyncToken(cfg.remoteUrl, projectRef.current.preferences.gitSyncUser ?? {});
      if (!token) return;
      setSyncingBoth(true);
      await flushPendingAutosave();
      snapshotMergeAncestor();
      const summary = await pullProject(
        projectRef.current.projectDir,
        annDir,
        cfg.remoteUrl,
        token,
        projectRef.current.preferences.gitSyncUser?.authorName ?? '',
      );
      if (summary.pulled) {
        setReloadNonce(n => n + 1);
        setSyncIsAutoPull(true);
        setSyncSummary(summary);
        addLog(
          `Auto-pull: downloaded +${summary.annotationsAdded}/-${summary.annotationsRemoved} across ${summary.recordingsChanged.length} file(s)`
        );
      }
      const status = await getLocalSyncStatus(projectRef.current.projectDir, annDir);
      setHasLocalChanges(status.hasLocalChanges);
      setHasRemoteChanges(status.hasRemoteChanges);
    } catch {
      // silently ignore background auto-pull failures
    } finally {
      setSyncingBoth(false);
    }
  }, [flushPendingAutosave, snapshotMergeAncestor, addLog, setSyncingBoth]);

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
    handleSync,
    flushPendingAutosave,
  };
}
