import { useRef, useEffect } from 'react';
import { Annotation, AnnotationTool, LoadedAnnotations, Project } from '../types';
import { readTextFile } from '../utils/tauriCommands';
import { parseAudacityContent, generateAudacityContent } from '../utils/helpers';
import {
  annotationFileContent, persistAnnotations, persistAnnotationsIfChanged, recallDiskContent, rememberDiskContent,
} from '../utils/annotationPersist';
import { getLocalSyncStatus } from '../utils/tauriCommands';
import { setMergeAnnotations } from '../utils/projectCommands';
import type { AnnotationIoGate } from '../utils/annotationIoGate';
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
  // Which track is hydrated AND that track's annotations, as one atomic value
  // (see LoadedAnnotations in types.ts). Seeded here the moment a read
  // completes — track and list assigned together — and kept current as the user
  // edits by an effect in the orchestrator. Until it names the current track,
  // nothing may be persisted: `annotations` is the transient [] from the track
  // switch, and persisting that deleted real annotation files.
  loadedAnnotationsRef: React.MutableRefObject<LoadedAnnotations | null>;
  // True while a git sync/merge/checkout is running. The autosave suspends disk
  // writes while set, so a debounced write can't race the forced checkout.
  syncingRef: React.MutableRefObject<boolean>;
  // Bumped after a pull so the auto-load effect re-reads disk.
  reloadNonce: number;
  // This effect's in-flight read-and-merge is work a track switch must wait for
  // (see utils/annotationIoGate.ts); it also claims the reload requests that
  // asked for it to run.
  ioGate: AnnotationIoGate;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

// Owns annotation disk I/O for the active track: the getAnnotationPath mapping
// (audio dir → annotation dir, the path contract the tests pin), the debounced
// auto-save effect, and the auto-load effect. The autosave timer ref is exposed
// so useSyncManagement can flush a pending write before syncing.
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
  loadedAnnotationsRef,
  syncingRef,
  reloadNonce,
  ioGate,
  addLog,
}: UseAnnotationLoadArgs) {
  // Bumped per load, so a slower earlier read of the same track (a refresh and
  // a post-pull reload racing) can't land after a newer one.
  const loadGenRef = useRef(0);

  useEffect(() => {
    if (!trackPath || !annotationDirectory) return;
    // Never arm the autosave before this track's file has been read from disk:
    // an early timer would fire against the empty placeholder state and delete
    // or truncate the real file (the load itself may take longer than the
    // debounce, or never complete if the read errors).
    if (loadedAnnotationsRef.current?.trackPath !== trackPath) return;
    const annotPath = getAnnotationPath(trackPath);
    if (!annotPath) return;
    // Snapshot the identity at effect time so the async callback can verify
    // it's still relevant after the debounce delay.
    const savedTrackPath = trackPath;
    const savedAnnotPath = annotPath;

    // Debounce saves by 300ms
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    const runSave = async () => {
      // The timer has fired: nothing is pending any more. flushPendingAutosave
      // reads this handle to decide whether a sync must flush first, and a
      // stale truthy handle made it flush the just-loaded state back to disk.
      autoSaveTimeoutRef.current = null;
      // Guard: bail if the track changed while we were waiting.
      if (savedTrackPath !== trackPathRef.current) return;
      // Never write while a sync/merge/checkout is running, or while the reload
      // after it is pending: a write during the sync is reverted by its forced
      // checkout, and one between the sync and the reload would overwrite the
      // pulled file with the pre-pull list (and become the merge ancestor, so
      // the teammates' changes would be dropped). Re-arm and retry; the
      // reload's three-way merge folds this edit in from memory.
      if (syncingRef.current || ioGate.busy) {
        autoSaveTimeoutRef.current = setTimeout(runSave, 300);
        return;
      }
      try {
        const decimals = projectRef.current?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
        // Skips a write that would change nothing — notably the first run after
        // a load, which sees exactly the list just read.
        const result = await persistAnnotationsIfChanged(savedAnnotPath, annotations, decimals);
        if (result === 'unchanged') return;
        const cfg = projectRef.current;
        if (cfg?.settings.gitSync) {
          // Numerical (canonical record-set) comparison against HEAD, not a
          // dirty-on-any-write flag — an edit reverted back to the same
          // records (including precision-only rewrites) must not light the
          // sync indicator. Mirrors the check `stage_and_commit` itself uses,
          // so the dot and the actual commit-or-skip decision never disagree.
          try {
            const status = await getLocalSyncStatus(cfg.projectDir, cfg.annotationDirectoryAbs);
            if (savedTrackPath === trackPathRef.current) setHasLocalChanges(status.hasLocalChanges);
          } catch {
            if (savedTrackPath === trackPathRef.current) setHasLocalChanges(true);
          }
        }
        setAnnotatedFiles(prev => {
          const next = new Set(prev);
          if (result === 'cleared') next.delete(savedTrackPath);
          else next.add(savedTrackPath);
          return next;
        });
      } catch (err) {
        addLog(`Auto-save error: ${err}`, 'error');
      }
    };
    autoSaveTimeoutRef.current = setTimeout(runSave, 300);

    return () => {
      // Null it, don't just clear it. flushPendingAutosave treats a non-null
      // handle as "a save is pending"; leaving a cleared-but-truthy handle
      // behind made every flush run even when there was nothing to flush.
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
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
    const gen = ++loadGenRef.current;
    // Capture the in-memory list for THIS track before disarming — a reload of
    // the open track (after a pull, or a refresh) merges it with disk, and
    // disarming is what makes it unreadable. Null on a track switch or mid-load,
    // when there is no trustworthy in-memory state and disk simply wins.
    const ours = loadedAnnotationsRef.current?.trackPath === expectedTrackPath
      ? loadedAnnotationsRef.current.annotations
      : null;
    // The file as we last wrote or read it: the merge ancestor. Captured now,
    // before anything below can update it.
    const ancestor = ours !== null ? recallDiskContent(annotPath) : undefined;
    // Disarm all persistence for this track until the read completes; if the
    // read errors we stay disarmed rather than risk saving state that doesn't
    // reflect what's on disk.
    loadedAnnotationsRef.current = null;
    // Begin our own gate operation before claiming the reload requests, so the
    // gate never reads idle between the request and this read.
    const endGateOp = ioGate.begin();
    ioGate.claimReloads();
    const current = () => gen === loadGenRef.current && trackPathRef.current === expectedTrackPath;

    (async () => {
      try {
        const content = await readTextFile(annotPath);
        if (!current()) return;

        const decimals = projectRef.current?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
        const diskContent = content ?? '';

        let list: Annotation[];
        if (ours !== null && ancestor !== undefined) {
          // A reload of the open track: the file may have changed under us (a
          // pull's checkout, an external edit) while memory may hold an edit
          // that never reached disk (made during the sync, or inside the
          // autosave debounce). Three-way-merge them against what the file held
          // when we last wrote or read it — the same merge a sync uses — rather
          // than letting either side replace the other.
          const merged = await setMergeAnnotations(ancestor, generateAudacityContent(ours, decimals), diskContent);
          if (!current()) return;
          list = merged ? parseAudacityContent(merged, annotationToolsRef.current) : [];
          if (merged !== diskContent) {
            await persistAnnotations(annotPath, list, decimals);
            if (!current()) return;
          }
        } else {
          // An empty/missing file loads as [] — applied like any other result so
          // stale in-memory annotations can't survive a pull that emptied the
          // file on disk and then get re-written over it.
          list = content ? parseAudacityContent(content, annotationToolsRef.current) : [];
        }

        // What the file now holds as far as persistence is concerned, so the
        // autosave that sees this list skips its no-op write.
        rememberDiskContent(annotPath, annotationFileContent(list, decimals));
        setAnnotations(list);
        annotationsHistoryRef.current = [list];
        historyIndexRef.current = 0;
        // Arm persistence with the track and the list TOGETHER. Arming the
        // track alone and letting a separately-mirrored list catch up on the
        // next render left a window in which a flush wrote the placeholder []
        // over a real file — persistAnnotations turns an empty list into a
        // delete, so two annotated recordings were removed and the deletion
        // pushed to the whole team.
        loadedAnnotationsRef.current = { trackPath: expectedTrackPath, annotations: list };
        if (list.length > 0) addLog(`Loaded ${list.length} annotations`);
      } catch (err) {
        addLog(`Error loading annotations: ${err}`, 'error');
      } finally {
        endGateOp();
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackPath, annotationDirectory, currentDirectory, reloadNonce]);
}
