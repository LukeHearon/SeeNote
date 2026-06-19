import { useState, useCallback } from 'react';
import { Annotation } from '../types';
import { openFileDialog, readTextFile, writeTextFile } from '../utils/tauriCommands';
import { generateAudacityContent, mergeAnnotations, parseAudacityContent } from '../utils/helpers';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS } from '../constants';

interface UseImportAnnotationsArgs {
  annotationDirectory: string | null;
  currentDirectory: string | null;
  projectRef: React.MutableRefObject<import('../types').Project>;
  trackPathRef: React.MutableRefObject<string | null>;
  annotationToolsRef: React.MutableRefObject<import('../types').AnnotationTool[]>;
  getAnnotationPath: (trackFilePath: string) => string | null;
  // Live-track writes route through the shared commit path so undo history +
  // auto-save apply; owned by AnnotationWindow (useAnnotationHistory).
  handleAnnotationsCommit: (next: Annotation[]) => void;
  setAnnotatedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

// Owns the import-annotations flow: the parse-error toast, the overwrite/merge
// confirmation state, and the write path that mirrors auto-save (live track via
// commit, other tracks straight to disk).
export function useImportAnnotations({
  annotationDirectory,
  currentDirectory,
  projectRef,
  trackPathRef,
  annotationToolsRef,
  getAnnotationPath,
  handleAnnotationsCommit,
  setAnnotatedFiles,
  addLog,
}: UseImportAnnotationsArgs) {
  const [importError, setImportError] = useState<string | null>(null);

  // Pending state for the overwrite/merge confirmation when the target track
  // already has annotations on disk.
  const [pendingImport, setPendingImport] = useState<{
    trackPath: string;
    incoming: Annotation[];
    existing: Annotation[];
    sourceName: string;
  } | null>(null);

  // Write `next` as the annotation file for `targetTrack`, mirroring auto-save.
  // If `targetTrack` is the currently-open track, also drive in-memory state so
  // the spectrogram updates live; otherwise just persist to disk.
  const writeAnnotationsForTrack = useCallback(async (targetTrack: string, next: Annotation[]) => {
    const annotPath = getAnnotationPath(targetTrack);
    if (!annotPath) return;
    const decimals = projectRef.current?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
    if (targetTrack === trackPathRef.current) {
      // Live track: route through commit so undo history + auto-save apply.
      handleAnnotationsCommit(next);
    } else {
      await writeTextFile(annotPath, generateAudacityContent(next, decimals));
    }
    setAnnotatedFiles(prev => {
      const updated = new Set(prev);
      if (next.length > 0) updated.add(targetTrack);
      else updated.delete(targetTrack);
      return updated;
    });
  }, [getAnnotationPath, handleAnnotationsCommit]);

  const handleImportAnnotations = useCallback(async (targetTrack: string) => {
    addLog(`[import] triggered — annotationDirectory=${annotationDirectory ?? 'null'} currentDirectory=${currentDirectory ?? 'null'}`);
    if (!annotationDirectory || !currentDirectory) {
      addLog('[import] aborted: no annotation directory or project directory', 'error');
      return;
    }
    try {
      const sourcePath = await openFileDialog(targetTrack, [
        { name: 'Annotation File', extensions: ['txt'] },
      ]);
      addLog(`[import] file dialog returned: ${sourcePath ?? 'cancelled'}`);
      if (!sourcePath) return;
      const content = await readTextFile(sourcePath);
      addLog(`[import] read ${content?.length ?? 0} chars`);
      if (!content) {
        addLog('Import: selected file was empty', 'error');
        return;
      }
      const sourceName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
      const incoming = parseAudacityContent(content, annotationToolsRef.current);
      addLog(`[import] parsed ${incoming.length} annotations`);
      if (incoming.length === 0) {
        addLog(`Import: "${sourceName}" could not be parsed as an annotation file`, 'error');
        setImportError(`"${sourceName}" could not be parsed as an annotation file.`);
        return;
      }

      // Read whatever is on disk for this track to decide whether to confirm.
      const annotPath = getAnnotationPath(targetTrack);
      const existingContent = annotPath ? await readTextFile(annotPath).catch(() => null) : null;
      const existing = existingContent
        ? parseAudacityContent(existingContent, annotationToolsRef.current)
        : [];

      if (existing.length > 0) {
        setPendingImport({ trackPath: targetTrack, incoming, existing, sourceName });
        return;
      }
      await writeAnnotationsForTrack(targetTrack, incoming);
      addLog(`Imported ${incoming.length} annotations from ${sourceName}`);
    } catch (err) {
      addLog(`Import error: ${err}`, 'error');
    }
  }, [annotationDirectory, currentDirectory, getAnnotationPath, writeAnnotationsForTrack]);

  const resolveImport = useCallback(async (mode: 'overwrite' | 'merge') => {
    if (!pendingImport) return;
    const { trackPath: targetTrack, incoming, existing, sourceName } = pendingImport;
    setPendingImport(null);
    try {
      const next = mode === 'merge' ? mergeAnnotations(existing, incoming) : incoming;
      await writeAnnotationsForTrack(targetTrack, next);
      addLog(`${mode === 'merge' ? 'Merged' : 'Imported'} ${incoming.length} annotations from ${sourceName}`);
    } catch (err) {
      addLog(`Import error: ${err}`, 'error');
    }
  }, [pendingImport, writeAnnotationsForTrack]);

  return {
    importError,
    setImportError,
    pendingImport,
    setPendingImport,
    writeAnnotationsForTrack,
    handleImportAnnotations,
    resolveImport,
  };
}
