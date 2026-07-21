import { useRef, useEffect } from 'react';
import { Annotation, AnnotationTool, Project } from '../types';
import { readTextFile } from '../utils/tauriCommands';
import { parseAudacityContent } from '../utils/helpers';
import { persistAnnotations } from '../utils/annotationPersist';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS } from '../constants';

interface UseAnnotationLoadArgs {
  projectRef: React.MutableRefObject<Project>;
  // Media-mirror path resolver. Single definition lives in the orchestrator
  // (the path contract is pinned by tests) and is shared with every consumer;
  // this hook drives the auto-load / auto-save effects off it.
  getAnnotationPath: (trackFilePath: string) => string | null;
  annotationDirectory: string | null;
  currentDirectory: string | null;
  trackPath: string | null;
  trackPathRef: React.MutableRefObject<string | null>;
  annotations: Annotation[];
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  annotationToolsRef: React.MutableRefObject<AnnotationTool[]>;
  annotationsHistoryRef: React.MutableRefObject<Annotation[][]>;
  historyIndexRef: React.MutableRefObject<number>;
  setAnnotatedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  setHasLocalChanges: (v: boolean) => void;
  // Pending-save timer. Created in the orchestrator because useSyncManagement
  // also flushes it before a sync; shared by both, owned by neither.
  autoSaveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  // Which track's annotations have finished loading from disk. Until this
  // matches the current track, `annotations` is the transient [] from the
  // track switch and MUST NOT be persisted — doing so truncated or deleted
  // real annotation files. Shared with useSyncManagement's flush.
  loadedAnnotationTrackRef: React.MutableRefObject<string | null>;
  // Bumped after a pull so the auto-load effect re-reads disk.
  reloadNonce: number;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

// Owns annotation disk I/O for the active track: the getAnnotationPath mapping
// (audio dir → annotation dir, the path contract the tests pin), the debounced
// auto-save effect, and the auto-load effect. The autosave timer ref is exposed
// so useSyncManagement can flush a pending write before syncing. skipAutoSaveRef
// is internal — it parks the autosave for ~500ms after a load so a fresh read
// doesn't immediately re-write the file.
export function useAnnotationLoad({
  projectRef,
  getAnnotationPath,
  annotationDirectory,
  currentDirectory,
  trackPath,
  trackPathRef,
  annotations,
  setAnnotations,
  annotationToolsRef,
  annotationsHistoryRef,
  historyIndexRef,
  setAnnotatedFiles,
  setHasLocalChanges,
  autoSaveTimeoutRef,
  loadedAnnotationTrackRef,
  reloadNonce,
  addLog,
}: UseAnnotationLoadArgs) {
  const skipAutoSaveRef = useRef(false);

  useEffect(() => {
    if (!trackPath || !annotationDirectory) return;
    // Never arm the autosave before this track's file has been read from disk:
    // an early timer would fire against the empty placeholder state and delete
    // or truncate the real file (the load itself may take longer than the
    // debounce, or never complete if the read errors).
    if (loadedAnnotationTrackRef.current !== trackPath) return;
    const annotPath = getAnnotationPath(trackPath);
    if (!annotPath) return;
    // Snapshot the identity at effect time so the async callback can verify
    // it's still relevant after the debounce delay.
    const savedTrackPath = trackPath;
    const savedAnnotPath = annotPath;

    // Debounce saves by 300ms
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (skipAutoSaveRef.current) return;
      // Guard: bail if the track changed while we were waiting.
      if (savedTrackPath !== trackPathRef.current) return;
      try {
        const decimals = projectRef.current?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
        const result = await persistAnnotations(savedAnnotPath, annotations, decimals);
        if (projectRef.current?.settings.gitSync) setHasLocalChanges(true);
        setAnnotatedFiles(prev => {
          const next = new Set(prev);
          if (result === 'removed') next.delete(savedTrackPath);
          else next.add(savedTrackPath);
          return next;
        });
      } catch (err) {
        addLog(`Auto-save error: ${err}`, 'error');
      }
    }, 300);

    return () => {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, trackPath, annotationDirectory, getAnnotationPath]);

  // Auto-load annotations when the current track or annotation directory changes
  useEffect(() => {
    if (!trackPath || !annotationDirectory || !currentDirectory) return;
    const annotPath = getAnnotationPath(trackPath);
    if (!annotPath) return;
    // Snapshot identity at effect-schedule time so async resolution can verify
    // the track hasn't changed while we were awaiting I/O.
    const expectedTrackPath = trackPath;
    // Disarm all persistence for this track until the read completes; if the
    // read errors we stay disarmed rather than risk saving state that doesn't
    // reflect what's on disk.
    loadedAnnotationTrackRef.current = null;

    (async () => {
      try {
        const content = await readTextFile(annotPath);
        // Drop result if the user switched tracks while we were reading.
        if (trackPathRef.current !== expectedTrackPath) return;

        // An empty/missing file loads as [] — applied like any other result so
        // stale in-memory annotations can't survive a pull that emptied the
        // file on disk and then get re-written over it.
        const loaded = content ? parseAudacityContent(content, annotationToolsRef.current) : [];

        skipAutoSaveRef.current = true;
        setAnnotations(loaded);
        annotationsHistoryRef.current = [loaded];
        historyIndexRef.current = 0;
        loadedAnnotationTrackRef.current = expectedTrackPath;
        if (loaded.length > 0) addLog(`Loaded ${loaded.length} annotations`);
        setTimeout(() => { skipAutoSaveRef.current = false; }, 500);
      } catch (err) {
        addLog(`Error loading annotations: ${err}`, 'error');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackPath, annotationDirectory, currentDirectory, reloadNonce]);

  return {
    skipAutoSaveRef,
  };
}
