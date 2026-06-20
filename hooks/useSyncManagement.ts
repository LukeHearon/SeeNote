import { useState, useEffect, useCallback } from 'react';
import { Annotation, Project } from '../types';
import { writeTextFile, syncProject, getLocalSyncStatus, fetchRemoteStatus, type SyncSummary } from '../utils/tauriCommands';
import { readSyncToken } from '../utils/gitSync';
import { generateAudacityContent } from '../utils/helpers';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS } from '../constants';

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
  addLog,
}: UseSyncManagementArgs) {
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const [hasRemoteChanges, setHasRemoteChanges] = useState(false);
  // Bumped after a pull so the auto-load effect re-reads the active track's
  // annotation file (which may have changed on disk during the merge).
  const [reloadNonce, setReloadNonce] = useState(0);

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
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    try {
      // Flush a pending debounced autosave so in-flight edits are committed.
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        const annotPath = trackPathRef.current ? getAnnotationPath(trackPathRef.current) : null;
        if (annotPath) {
          await writeTextFile(annotPath, generateAudacityContent(annotations, project.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS));
        }
      }
      const token = await readSyncToken(cfg.remoteUrl, projectRef.current.preferences.gitSyncUser ?? {});
      if (!token) {
        setSyncError('No access token found for this repository. Open Project Settings → Sync to enter your PAT.');
        setSyncing(false);
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
      setSyncing(false);
    }
  }, [annotations, getAnnotationPath, project.settings.outputRoundingDecimals, addLog]);

  // On project load, check initial sync status (local only, no network).
  useEffect(() => {
    const cfg = project.settings.gitSync;
    const annDir = project.annotationDirectoryAbs;
    if (!cfg?.remoteUrl || !annDir) return;
    getLocalSyncStatus(project.projectDir, annDir)
      .then(status => {
        setHasLocalChanges(status.hasLocalChanges);
        setHasRemoteChanges(status.hasRemoteChanges);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.projectDir]);

  // Heartbeat: fetch remote and check if it's ahead (every 2 minutes).
  useEffect(() => {
    const cfg = project.settings.gitSync;
    if (!cfg?.remoteUrl) return;
    const dir = project.projectDir;
    const url = cfg.remoteUrl;
    const id = setInterval(async () => {
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
  }, [project.projectDir, project.settings.gitSync?.remoteUrl]);

  return {
    syncing,
    syncSummary,
    setSyncSummary,
    syncError,
    setSyncError,
    hasLocalChanges,
    setHasLocalChanges,
    hasRemoteChanges,
    reloadNonce,
    handleSync,
  };
}
