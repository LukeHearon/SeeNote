import { useState, useRef, useEffect, useCallback } from 'react';
import type { Project } from '../types';
import type { DirScan, ScanSpec } from '../utils/tauriCommands';
import { readScanCache, clearScanCache, setScanPriorityFolder } from '../utils/tauriCommands';
import { scanDirectory, MEDIA_SCAN, ANNOTATION_SCAN, BUZZDETECT_SCAN, BUZZDETECT_SUFFIXES } from '../utils/dirScan';
import { tracksWithResults } from '../utils/resultPresence';
import { isInsideDir, joinPath } from '../utils/projectPaths';
import { ANNOTATION_FILE_EXT } from '../constants';

type ScanKind = 'media' | 'annotations' | 'buzzdetect';

const mergeUnique = (a: string[], b: string[]) => (b.length === 0 ? a : [...new Set([...a, ...b])]);

interface ProjectScansParams {
  project: Project;
  /** The media list, owned by useFileNavigation. */
  allTracks: string[];
  setAllMediaFiles: (files: string[]) => void;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * The media tree, the annotation files, and the buzzdetect results are all
 * "list the files under this root" jobs, run by one scanner (utils/dirScan.ts,
 * src-tauri/src/commands/scan.rs). runScan is the shared front end: with
 * `useCache` the last scan's list shows immediately (and `onCached` fires)
 * while the real scan runs; otherwise partial results stream in as they're
 * found, unless `streamPartials` is false (a refresh, where the list is
 * already populated). Each run resolves with the final lists, or null if a
 * newer scan of the same kind superseded it.
 */
export function useProjectScans({ project, allTracks, setAllMediaFiles, addLog }: ProjectScansParams) {
  // Tracks with an annotation file.
  const [annotatedTracks, setAnnotatedFiles] = useState<Set<string>>(new Set());
  // Tracks with a buzzdetect result file. Always empty when the project has no
  // buzzdetect directory.
  const [buzzdetectTracks, setBuzzdetectTracks] = useState<Set<string>>(new Set());
  const [allNonMediaFiles, setAllNonMediaFiles] = useState<string[]>([]);

  const [scanning, setScanning] = useState<ReadonlySet<ScanKind>>(() => new Set());
  const scanTokens = useRef<Record<ScanKind, number>>({ media: 0, annotations: 0, buzzdetect: 0 });
  const runScan = useCallback(async (
    kind: ScanKind,
    root: string,
    spec: ScanSpec,
    apply: (scan: DirScan) => void,
    opts: { useCache?: boolean; streamPartials?: boolean; onCached?: (scan: DirScan) => void; after?: Promise<unknown> } = {},
  ): Promise<DirScan | null> => {
    const token = ++scanTokens.current[kind];
    const isCurrent = () => scanTokens.current[kind] === token;
    const mark = (on: boolean) => setScanning(prev => {
      const next = new Set(prev);
      if (on) next.add(kind); else next.delete(kind);
      return next;
    });
    let showedCache = false;
    let finished = false;
    mark(true);
    try {
      // `after` holds the walk back (the cache read below still starts now), for
      // scans that would only fight another scan for the same drive.
      const scanPromise = (opts.after ?? Promise.resolve()).then(() => scanDirectory(root, spec, partial => {
        if (isCurrent() && !showedCache && (opts.streamPartials ?? true)) apply(partial);
      }));
      if (opts.useCache) {
        const cached = await readScanCache(root, spec).catch(() => null);
        if (cached && !finished && isCurrent()) {
          showedCache = true;
          apply(cached);
          opts.onCached?.(cached);
        }
      }
      const final = await scanPromise;
      finished = true;
      if (!final || !isCurrent()) return null;
      apply(final);
      return final;
    } finally {
      if (isCurrent()) mark(false);
    }
  }, []);

  const runMediaScan = useCallback((
    root: string,
    opts: { useCache?: boolean; streamPartials?: boolean; onCached?: (scan: DirScan) => void } = {},
  ) => runScan('media', root, MEDIA_SCAN, scan => {
    setAllMediaFiles(scan.files);
    setAllNonMediaFiles(scan.others);
  }, opts), [runScan, setAllMediaFiles]);

  // Raw result-file lists from the last annotation / buzzdetect scans, and the
  // mapping from those onto tracks. Kept raw so a change to the track list (a
  // media rescan) re-derives presence without listing the result directories
  // again.
  const annotationFilesRef = useRef<string[]>([]);
  const buzzdetectFilesRef = useRef<string[]>([]);
  const applyPresence = useCallback((tracks: string[]) => {
    const mediaRoot = project.mediaDirectoryAbs;
    setAnnotatedFiles(tracksWithResults(
      tracks, mediaRoot, project.annotationDirectoryAbs, annotationFilesRef.current, [`.${ANNOTATION_FILE_EXT}`]));
    setBuzzdetectTracks(project.buzzdetectDirectoryAbs
      ? tracksWithResults(tracks, mediaRoot, project.buzzdetectDirectoryAbs, buzzdetectFilesRef.current, BUZZDETECT_SUFFIXES)
      : new Set());
  }, [project.mediaDirectoryAbs, project.annotationDirectoryAbs, project.buzzdetectDirectoryAbs, setAnnotatedFiles]);
  const allTracksRef = useRef<string[]>([]);
  useEffect(() => {
    allTracksRef.current = allTracks;
    applyPresence(allTracks);
  }, [allTracks, applyPresence]);

  const runAnnotationScan = useCallback((opts: { useCache?: boolean } = {}) =>
    runScan('annotations', project.annotationDirectoryAbs, ANNOTATION_SCAN, scan => {
      annotationFilesRef.current = scan.files;
      applyPresence(allTracksRef.current);
    }, opts), [runScan, applyPresence, project.annotationDirectoryAbs]);

  // Buzzdetect results usually sit on the same slow drive as the media, so the
  // full walk is held back until the media scan is done (`after`). Until it
  // starts, entering a folder scans just that folder's slice of the results
  // (scanBuzzdetectFolder), so its pips don't wait on the whole tree.
  const buzzWalkStartedRef = useRef(false);
  const buzzExtraRef = useRef<string[]>([]);
  const buzzFoldersScannedRef = useRef<Set<string>>(new Set());
  const buzzFoldersDoneRef = useRef<Set<string>>(new Set());

  const runBuzzdetectScan = useCallback(async (opts: { useCache?: boolean; after?: Promise<unknown> } = {}) => {
    const dir = project.buzzdetectDirectoryAbs;
    if (!dir) return null;
    buzzWalkStartedRef.current = !opts.after;
    buzzFoldersScannedRef.current = new Set();
    buzzFoldersDoneRef.current = new Set();
    const after = opts.after?.then(() => { buzzWalkStartedRef.current = true; });
    const final = await runScan('buzzdetect', dir, BUZZDETECT_SCAN, scan => {
      // Keep what folder scans found until the full list is in.
      buzzdetectFilesRef.current = mergeUnique(scan.files, buzzExtraRef.current);
      applyPresence(allTracksRef.current);
    }, { useCache: opts.useCache, after });
    if (final) {
      buzzExtraRef.current = [];
      buzzdetectFilesRef.current = final.files;
    }
    return final;
  }, [runScan, applyPresence, project.buzzdetectDirectoryAbs]);

  const scanBuzzdetectFolder = useCallback(async (rel: string) => {
    const dir = project.buzzdetectDirectoryAbs;
    if (!dir) return;
    // A subtree scan: the full walk later skips this folder and reuses the result.
    const found = await scanDirectory(joinPath(dir, rel), BUZZDETECT_SCAN, () => {}, true).catch(() => null);
    buzzFoldersDoneRef.current.add(rel);
    // If the full walk started meanwhile it covers this folder as well (Rust
    // holds the result only for a walk that starts later).
    if (!found || buzzWalkStartedRef.current) return;
    buzzExtraRef.current = mergeUnique(buzzExtraRef.current, found.files);
    buzzdetectFilesRef.current = mergeUnique(buzzdetectFilesRef.current, found.files);
    applyPresence(allTracksRef.current);
  }, [applyPresence, project.buzzdetectDirectoryAbs]);

  // Point each running scan at the folder the file tree is showing, mapped
  // onto that scan's root (the annotation and buzzdetect trees mirror the media
  // tree's layout).
  useEffect(() => {
    const mediaRoot = project.mediaDirectoryAbs;
    const entered = project.preferences.enteredFolderPath ?? null;
    const rel = entered && isInsideDir(mediaRoot, entered) ? entered.substring(mediaRoot.length + 1) : null;
    const mirrored = (root: string) => (rel ? joinPath(root, rel) : null);
    setScanPriorityFolder(mediaRoot, entered).catch(() => {});
    setScanPriorityFolder(project.annotationDirectoryAbs, mirrored(project.annotationDirectoryAbs)).catch(() => {});
    if (project.buzzdetectDirectoryAbs) {
      setScanPriorityFolder(project.buzzdetectDirectoryAbs, mirrored(project.buzzdetectDirectoryAbs)).catch(() => {});
      // Skip a folder already covered: scanned itself, or inside one that was.
      // Drilling down one level at a time lands here for every level after the
      // first. If the covering scan is still running, point it at the folder
      // you're in now so you aren't waiting on the rest of its subtree.
      const covering = rel === null ? undefined : [...buzzFoldersScannedRef.current].find(
        r => rel === r || rel.startsWith(r + '/') || rel.startsWith(r + '\\'));
      if (rel && covering !== undefined && !buzzWalkStartedRef.current && !buzzFoldersDoneRef.current.has(covering)) {
        setScanPriorityFolder(joinPath(project.buzzdetectDirectoryAbs, covering), mirrored(project.buzzdetectDirectoryAbs)).catch(() => {});
      }
      if (rel && !buzzWalkStartedRef.current && covering === undefined) {
        buzzFoldersScannedRef.current.add(rel);
        scanBuzzdetectFolder(rel);
      }
    }
  }, [project.mediaDirectoryAbs, project.annotationDirectoryAbs, project.buzzdetectDirectoryAbs,
      project.preferences.enteredFolderPath, scanBuzzdetectFolder]);

  // Soft refresh of the file list: keep what's on screen and swap in the result
  // when the scan finishes. This is the path git pulls take.
  const handleRefreshFiles = useCallback(async () => {
    try {
      await runMediaScan(project.mediaDirectoryAbs, { streamPartials: false });
      await runAnnotationScan();
    } catch (err) {
      addLog(`Error refreshing files: ${err}`, 'error');
    }
  }, [project, runMediaScan, runAnnotationScan]);

  // Hard refreshes, one per kind of on-disk data, so a change to one doesn't
  // cost a rescan of the rest. Each drops its scan cache (a stale list must not
  // reappear if the app quits mid-scan) and rebuilds from scratch. The
  // annotation and buzzdetect ones are composed by the window, which also
  // reloads what it holds of that data.
  const refreshFileTree = useCallback(async () => {
    try {
      await clearScanCache(project.mediaDirectoryAbs, MEDIA_SCAN).catch(() => {});
      setAllMediaFiles([]);
      setAllNonMediaFiles([]);
      await runMediaScan(project.mediaDirectoryAbs);
    } catch (err) {
      addLog(`Error refreshing files: ${err}`, 'error');
    }
  }, [project.mediaDirectoryAbs, runMediaScan, setAllMediaFiles]);

  const rescanAnnotations = useCallback(async () => {
    await clearScanCache(project.annotationDirectoryAbs, ANNOTATION_SCAN).catch(() => {});
    await runAnnotationScan();
  }, [project.annotationDirectoryAbs, runAnnotationScan]);

  const rescanBuzzdetect = useCallback(async () => {
    const dir = project.buzzdetectDirectoryAbs;
    if (!dir) return;
    await clearScanCache(dir, BUZZDETECT_SCAN).catch(() => {});
    await runBuzzdetectScan();
  }, [project.buzzdetectDirectoryAbs, runBuzzdetectScan]);

  return {
    scanning,
    annotatedTracks, setAnnotatedFiles,
    buzzdetectTracks,
    allNonMediaFiles, setAllNonMediaFiles,
    runMediaScan, runAnnotationScan, runBuzzdetectScan,
    handleRefreshFiles, refreshFileTree, rescanAnnotations, rescanBuzzdetect,
  };
}
