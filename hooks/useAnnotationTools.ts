import { useState, useRef, useEffect, useCallback } from 'react';
import { Annotation, AnnotationTool, Project, ProjectPreferences } from '../types';
import { HOTKEY_COLORS } from '../constants';
import { generateId } from '../utils/helpers';
import {
  listAnnotationTools, listToolExamples, createAnnotationTool, updateAnnotationTool,
  renameAnnotationTool, deleteAnnotationTool, importToolExamples, importExamplesToTool,
} from '../utils/tauriCommands';
import { readTextFile, writeTextFile } from '../utils/tauriCommands';
import {
  PersistedTool, assembleTools, buildHotkeyMap, diffToolFolders, makeCustomTool,
  mergeImportedTools, toPersistedTools,
} from '../utils/annotationTools';
import { openDirectoryDialog } from '../utils/tauriCommands';
import type { useExamplePlayer } from './useExamplePlayer';

interface UseAnnotationToolsArgs {
  project: Project;
  projectRef: React.MutableRefObject<Project>;
  // Shared with the project-tool persistence guard so a project switch doesn't
  // overwrite folders with stale tools. Owned by AnnotationWindow.
  prevProjectIdRef: React.MutableRefObject<string | null>;
  updateProjectPreferences: (id: string, preferences: ProjectPreferences) => Promise<Project | undefined>;
  addLog: (msg: string, type?: 'info' | 'error') => void;
  examplePlayer: ReturnType<typeof useExamplePlayer>;
  // Annotation list ownership stays in AnnotationWindow; rename/delete/reorder
  // mutate it through these.
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  handleAnnotationsCommit: (next: Annotation[]) => void;
  // Active tool key ownership stays in AnnotationWindow; delete/reorder can clear
  // or remap it.
  activeToolKey: string | null;
  setActiveToolKey: React.Dispatch<React.SetStateAction<string | null>>;
  // Cross-track rename rewrites every other track's annotation file on disk.
  allTracks: string[];
  trackPath: string | null;
  getAnnotationPath: (trackFilePath: string) => string | null;
}

// Owns the annotation-tool palette model: the in-memory tool array, its mirror
// ref, the folder-reconcile persistence effect, and every tool CRUD/import
// handler. Annotations and the active tool key remain owned by AnnotationWindow;
// rename/delete/reorder mutate them through the callbacks passed in.
export function useAnnotationTools({
  project,
  projectRef,
  prevProjectIdRef,
  updateProjectPreferences,
  addLog,
  examplePlayer,
  setAnnotations,
  handleAnnotationsCommit,
  activeToolKey,
  setActiveToolKey,
  allTracks,
  trackPath,
  getAnnotationPath,
}: UseAnnotationToolsArgs) {
  const [annotationTools, setAnnotationTools] = useState<AnnotationTool[]>(() => [makeCustomTool(HOTKEY_COLORS[0])]);
  // Mirror of annotationTools for use inside the annotation-load effect without
  // making it depend on (and re-run on) tool changes — re-running it would
  // re-read the on-disk file before the debounced autosave has written renames,
  // clobbering them.
  const annotationToolsRef = useRef(annotationTools);

  // Edit/delete triggered from the palette right-click context menu (outside the settings modal).
  const [panelEditingToolIndex, setPanelEditingToolIndex] = useState<number | null>(null);
  const [panelDeletingToolIndex, setPanelDeletingToolIndex] = useState<number | null>(null);
  // Index of the tool whose example-clip library is open (null = closed).
  const [libraryToolIndex, setLibraryToolIndex] = useState<number | null>(null);
  // True while the example-library modal is actively playing a clip.
  const [libraryPlaying, setLibraryPlaying] = useState(false);

  // Persist annotation tools and spectrogram settings to project whenever they change
  const toolPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last tool snapshot known to match the on-disk folders. The reconcile
  // effect diffs against this to derive folder create/rename/update/delete ops.
  const prevPersistedToolsRef = useRef<PersistedTool[]>([]);
  // Set by the load path so the reconcile effect skips the setAnnotationTools
  // it triggers (the loaded array already matches the folders).
  const skipToolPersistRef = useRef(false);

  // Keep annotationToolsRef in sync so the load effect can look up current tools
  // for color/toolKey matching without depending on annotationTools.
  useEffect(() => { annotationToolsRef.current = annotationTools; }, [annotationTools]);

  // Open the read-only example library for a tool; stop any chip-button preview
  // first so the two don't play over each other.
  const handleShowExamples = useCallback((toolIndex: number) => {
    examplePlayer.stop();
    setLibraryToolIndex(toolIndex);
  }, [examplePlayer]);

  // Assemble the in-memory tool array from the project's tool folders +
  // hotkey map. Used on mount and after the project settings modal saves.
  const loadAnnotationTools = useCallback(async (proj: Project) => {
    try {
      const folderTools = await listAnnotationTools(proj.projectDir);
      const tools = assembleTools(
        folderTools,
        proj.preferences.toolHotkeys ?? {},
        HOTKEY_COLORS[0],
        () => generateId(),
      );
      prevPersistedToolsRef.current = toPersistedTools(tools);
      skipToolPersistRef.current = true;
      setAnnotationTools(tools);
    } catch (err) {
      addLog(`Error loading annotation tools: ${err}`, 'error');
    }
  }, []);

  // Reconcile in-memory tools to disk: folder ops from the snapshot diff, then
  // the hotkey map + Custom color into settings.json. Debounced so rapid
  // changes (e.g. live color preview drags) collapse into one write.
  useEffect(() => {
    // Skip persistence when switching projects (avoids overwriting with stale tools)
    if (prevProjectIdRef.current !== project.id) {
      prevProjectIdRef.current = project.id;
      return;
    }
    if (skipToolPersistRef.current) {
      skipToolPersistRef.current = false;
      return;
    }
    if (toolPersistRef.current) clearTimeout(toolPersistRef.current);
    toolPersistRef.current = setTimeout(async () => {
      const proj = projectRef.current;
      if (!proj) return;
      const next = toPersistedTools(annotationTools);
      const ops = diffToolFolders(prevPersistedToolsRef.current, next);
      try {
        // Deletes first so a freed label can be reused by a rename or create
        // in the same batch (e.g. undo of a delete recreates the same label
        // under a new id).
        for (const d of ops.deletes) await deleteAnnotationTool(proj.projectDir, d);
        for (const r of ops.renames) await renameAnnotationTool(proj.projectDir, r.from, r.to);
        for (const c of ops.creates) await createAnnotationTool(proj.projectDir, c.text, c.color, c.description);
        for (const u of ops.updates) await updateAnnotationTool(proj.projectDir, u.text, u.color, u.description);
        prevPersistedToolsRef.current = next;
      } catch (err) {
        addLog(`Error saving annotation tools: ${err}`, 'error');
      }
      updateProjectPreferences(proj.id, {
        ...proj.preferences,
        toolHotkeys: buildHotkeyMap(annotationTools),
      });
    }, 500);
    return () => {
      if (toolPersistRef.current) clearTimeout(toolPersistRef.current);
    };
  }, [annotationTools]);

  const handleCreateTool = useCallback((text: string, color: string, key?: string | null) => {
    setAnnotationTools(prev => [...prev, { id: generateId(), key: key ?? null, text, color }]);
  }, []);

  // "Import examples" in the tool settings modal: pick a directory of plain
  // {label}/ folders of audio clips; the backend creates the appropriate tool
  // dirs and copies the clips, then the folder scan is merged into the
  // in-memory tools (keeping pending edits and hotkeys intact).
  const handleImportExamples = useCallback(async () => {
    const proj = projectRef.current;
    if (!proj) return;
    const dir = await openDirectoryDialog();
    if (!dir) return;
    try {
      const summary = await importToolExamples(proj.projectDir, dir, HOTKEY_COLORS.slice(1));
      const folderTools = await listAnnotationTools(proj.projectDir);
      const { tools, added } = mergeImportedTools(annotationToolsRef.current, folderTools, () => generateId());
      // The import already wrote the added tools' folders — extend the
      // persisted snapshot so the reconcile diff doesn't re-create them.
      prevPersistedToolsRef.current = [...prevPersistedToolsRef.current, ...toPersistedTools(added)];
      setAnnotationTools(tools);
      addLog(`Imported examples: ${summary.files_copied} copied, ${summary.files_skipped} skipped, ${summary.tools_created.length} new tool(s)`);
    } catch (err) {
      addLog(`Import examples error: ${err}`, 'error');
    }
  }, [addLog]);

  // Per-tool example import: copy the selected files/folders into one tool's
  // examples/ dir, then refresh that tool's exampleFiles from the folder scan.
  // Skips Custom (key '0'), which is synthetic and has no folder.
  const handleImportExamplesToTool = useCallback(async (toolIndex: number, paths: string[]) => {
    const proj = projectRef.current;
    if (!proj || paths.length === 0) return;
    const tool = annotationToolsRef.current[toolIndex];
    if (!tool || tool.key === '0') return;
    try {
      const summary = await importExamplesToTool(proj.projectDir, tool.text, paths);
      const exampleFiles = await listToolExamples(proj.projectDir, tool.text);
      setAnnotationTools(prev => prev.map(t => t.id === tool.id ? { ...t, exampleFiles } : t));
      addLog(`Imported examples into "${tool.text}": ${summary.files_copied} copied, ${summary.files_skipped} skipped`);
    } catch (err) {
      addLog(`Import examples error: ${err}`, 'error');
    }
  }, [addLog]);

  // Atomically restore tools + annotations for the Annotation Tool Settings
  // modal's own undo/redo (e.g. undeleting a tool, which must also put back the
  // annotations that delete reassigned to Custom). Annotations go through the
  // shared commit path so the global annotation history stays consistent.
  const handleRestoreToolsState = useCallback((tools: AnnotationTool[], restoredAnnotations: Annotation[]) => {
    setAnnotationTools(tools);
    handleAnnotationsCommit(restoredAnnotations);
  }, [handleAnnotationsCommit]);

  const handleRenameTool = useCallback((toolIndex: number, newText: string, newColor: string, newDescription?: string) => {
    const tool = annotationTools[toolIndex];
    if (!tool) return;
    const oldText = tool.text;

    setAnnotationTools(prev => prev.map((t, i) => i === toolIndex ? { ...t, text: newText, color: newColor, description: newDescription } : t));
    setAnnotations(prev => prev.map(a => {
      if (a.toolKey === tool.key && a.toolKey !== '0') {
        return { ...a, text: newText, color: newColor };
      }
      if (a.toolKey === '0' && a.text === newText && tool.key !== null) {
        return { ...a, toolKey: tool.key!, color: newColor };
      }
      return a;
    }));

    // If only the color changed, no file text updates are needed.
    if (oldText === newText) return;

    // Rename matching annotations in every other track's annotation file on disk.
    // The current track's file will be updated by the auto-save triggered above.
    for (const t of allTracks) {
      if (t === trackPath) continue;
      const annotPath = getAnnotationPath(t);
      if (!annotPath) continue;
      (async () => {
        try {
          const content = await readTextFile(annotPath);
          if (!content) return;
          let changed = false;
          const updated = content.split('\n').map(line => {
            const parts = line.split('\t');
            if (parts.length >= 3 && parts.slice(2).join('\t') === oldText) {
              changed = true;
              return `${parts[0]}\t${parts[1]}\t${newText}`;
            }
            return line;
          });
          if (changed) await writeTextFile(annotPath, updated.join('\n'));
        } catch {
          // No annotation file for this track — nothing to update.
        }
      })();
    }
  }, [annotationTools, allTracks, trackPath, getAnnotationPath]);

  const handleDeleteTool = useCallback((toolIndex: number, mode: 'unlink' | 'delete') => {
    const tool = annotationTools[toolIndex];
    if (!tool) return;
    setAnnotations(prev => mode === 'delete'
      // Remove the tool's linked annotations entirely.
      ? prev.filter(a => a.toolKey !== tool.key)
      // Reassign the tool's linked annotations to Custom.
      : prev.map(a => a.toolKey === tool.key ? { ...a, toolKey: '0', color: '#ffffff' } : a)
    );
    setAnnotationTools(prev => prev.filter((_, i) => i !== toolIndex));
    if (activeToolKey === tool.key) setActiveToolKey(null);
  }, [annotationTools, activeToolKey]);

  // Transient live preview while the user drags a color in the edit modal.
  // Updates ONLY the tool's color and its linked (non-Custom) annotations'
  // colors via the raw setters — no history push, no Custom reassociation. The
  // settings list and spectrogram both read these from state, so they update
  // live; the real commit (with history) happens on Save via handleRenameTool.
  const handlePreviewToolColor = useCallback((toolIndex: number, color: string) => {
    const tool = annotationToolsRef.current[toolIndex];
    if (!tool) return;
    setAnnotationTools(prev => prev.map((t, i) => i === toolIndex ? { ...t, color } : t));
    setAnnotations(prev => prev.map(a =>
      a.toolKey === tool.key && a.toolKey !== '0' ? { ...a, color } : a
    ));
  }, []);

  const handleReorderTools = useCallback((newTools: AnnotationTool[]) => {
    const snapshot = annotationTools;
    if (newTools.length !== snapshot.length) return;

    // Build old→new key remap (by stable index — newTools must preserve indices).
    const keyRemap = new Map<string, string>();
    const unassignedKeys = new Set<string>();
    for (let i = 0; i < snapshot.length; i++) {
      const oldKey = snapshot[i].key;
      const newKey = newTools[i].key;
      if (oldKey && newKey && oldKey !== newKey) keyRemap.set(oldKey, newKey);
      if (oldKey && !newKey) unassignedKeys.add(oldKey);
    }

    setAnnotationTools(newTools);
    setAnnotations(prev => prev.map(a => {
      if (unassignedKeys.has(a.toolKey)) return { ...a, toolKey: '0', color: '#ffffff' };
      const remapped = keyRemap.get(a.toolKey);
      return remapped ? { ...a, toolKey: remapped } : a;
    }));
    if (activeToolKey && (unassignedKeys.has(activeToolKey) || keyRemap.has(activeToolKey))) {
      setActiveToolKey(unassignedKeys.has(activeToolKey) ? null : keyRemap.get(activeToolKey)!);
    }
  }, [annotationTools, activeToolKey]);

  return {
    annotationTools,
    setAnnotationTools,
    annotationToolsRef,
    panelEditingToolIndex,
    setPanelEditingToolIndex,
    panelDeletingToolIndex,
    setPanelDeletingToolIndex,
    libraryToolIndex,
    setLibraryToolIndex,
    libraryPlaying,
    setLibraryPlaying,
    prevPersistedToolsRef,
    skipToolPersistRef,
    toolPersistRef,
    handleShowExamples,
    loadAnnotationTools,
    handleCreateTool,
    handleRenameTool,
    handleDeleteTool,
    handlePreviewToolColor,
    handleReorderTools,
    handleImportExamples,
    handleImportExamplesToTool,
    handleRestoreToolsState,
  };
}
