import { useRef, useEffect, useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { Annotation, AnnotationTool, Selection } from '../types';
import type { SpectrogramHandle } from '../components/Spectrogram';
import type { ActivationStackApi } from './useActivationStack';
import { makeAnnotationFromTool, makeAnnotationFromLabel } from '../utils/helpers';
import { resolveLabelColor } from '../utils/annotationTools';
import { bindAnnotationToHotkey, annotationMatchingTool } from '../utils/bindAnnotationHotkey';
import type { Timeline } from '../utils/subsetTimeline';

interface AnnotationCommandsParams {
  annotations: Annotation[];
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
  handleAnnotationsCommit: (next: Annotation[]) => void;
  annotationTools: AnnotationTool[];
  activeToolKey: string | null;
  setActiveToolKey: (key: string | null) => void;
  selection: Selection | null;
  selectionRef: MutableRefObject<Selection | null>;
  boundAnnotationId: string | null;
  setBoundAnnotationId: (id: string | null) => void;
  selectedAnnotationId: string | null;
  setSelectedAnnotationId: (id: string | null) => void;
  activationStack: ActivationStackApi;
  setFilterToolActive: (active: boolean) => void;
  selectionToSource: (s: Selection) => Selection;
  selectAllSpanAt: (t: number) => Selection;
  timeline: Timeline;
  displayDuration: number;
  currentTimeRef: MutableRefObject<number>;
  trackPathRef: MutableRefObject<string | null>;
  seek: (time: number, scroll?: boolean) => void;
  handleSelectionChange: (s: Selection | null) => void;
  spectrogramRef: RefObject<SpectrogramHandle | null>;
  handleBindHotkey: Parameters<typeof bindAnnotationToHotkey>[2]['onBindHotkey'];
  handleCreateTool: Parameters<typeof bindAnnotationToHotkey>[2]['onCreateTool'];
}

/**
 * The annotation window's editing commands: readying and switching tools
 * (including relabelling the bound annotation), Mod+A / Enter / Delete,
 * copy-paste, bind-to-hotkey, and resizing the bound annotation from the
 * keyboard or the toolbar's time fields.
 */
export function useAnnotationCommands({
  annotations, setAnnotations, handleAnnotationsCommit, annotationTools,
  activeToolKey, setActiveToolKey, selection, selectionRef,
  boundAnnotationId, setBoundAnnotationId, selectedAnnotationId, setSelectedAnnotationId,
  activationStack, setFilterToolActive, selectionToSource, selectAllSpanAt, timeline, displayDuration,
  currentTimeRef, trackPathRef, seek, handleSelectionChange, spectrogramRef,
  handleBindHotkey, handleCreateTool,
}: AnnotationCommandsParams) {
  // Label + span (source seconds) yanked by Mod+C, replayed by Mod+V at the
  // playhead. Persists across track switches (the window stays mounted).
  const annotationClipboardRef = useRef<{ text: string; color?: string; duration: number } | null>(null);
  // Per-session text buffer for annotation tool reassignment, keyed by hotkey
  // digit ('0' = Custom): saves the label held under each tool while an
  // annotation is bound, so switching back to a prior tool restores the
  // previously-entered text. Cleared when the bound annotation is deselected.
  const reassignBufferRef = useRef<Record<string, string>>({});

  // Clear the reassign buffer whenever the bound annotation changes (released or switched to another)
  useEffect(() => { reassignBufferRef.current = {}; }, [boundAnnotationId]);

  // If the bound annotation was deleted by an external path (e.g. empty-text
  // auto-delete on blur), clean up the tool state so handleToolActivate doesn't
  // get stuck in the bound-annotation branch with a missing target.
  useEffect(() => {
    if (boundAnnotationId !== null && !annotations.some(a => a.id === boundAnnotationId)) {
      setBoundAnnotationId(null);
      setActiveToolKey(null);
      activationStack.remove('annotationTool');
    }
  }, [annotations, boundAnnotationId, activationStack]);

  // Enter the annotation-tool layer: push its activation-stack entry and drop
  // the filter tool. The three side effects that always accompany readying a
  // tool, in one place.
  const enterAnnotationToolLayer = useCallback(() => {
      activationStack.pushIfAbsent('annotationTool');
      setFilterToolActive(false);
      activationStack.remove('filterTool');
  }, [activationStack]);

  // Ready a tool by key, unconditionally (no toggle-off, no selection/bound
  // side effects). Used when a tool has just been added from the palette.
  const readyTool = useCallback((key: string) => {
      setActiveToolKey(key);
      enterAnnotationToolLayer();
  }, [enterAnnotationToolLayer]);

  // Commit a new annotation and leave it selected and bound — the end state of
  // every way of making one (a tool key over a selection, Mod+A, a keyboard
  // extend, paste).
  const addBoundAnnotation = useCallback((a: Annotation) => {
      handleAnnotationsCommit([...annotations, a]);
      setSelectedAnnotationId(a.id);
      setBoundAnnotationId(a.id);
  }, [annotations, handleAnnotationsCommit]);
  // A new annotation from `tool` spanning a display-time selection.
  const addToolAnnotation = useCallback((tool: AnnotationTool, span: Selection) => {
      const src = selectionToSource(span);
      addBoundAnnotation(makeAnnotationFromTool(tool, src.start, src.end));
  }, [selectionToSource, addBoundAnnotation]);

  // Shared handler for activating an annotation tool by key — used by both
  // number hotkeys and palette clicks. Also manages the `annotationTool` entry
  // in the activation stack: pushIfAbsent on activate, remove when this
  // call toggles the tool off (same key pressed twice).
  const handleToolActivate = useCallback((key: string) => {
      const tool = annotationTools.find(t => t.key === key);
      if (!tool) return;
      const isCustom = tool.key === '0';
      if (boundAnnotationId !== null) {
          const currentAnnotation = annotations.find(a => a.id === boundAnnotationId);
          if (currentAnnotation) {
              // The annotation's current owner is whichever defined tool shares
              // its label; if none, it's a Custom label (bucket '0'). Stash its
              // text under that owner so toggling back restores what was typed.
              const currentOwner = annotationTools.find(t => t.key !== '0' && t.text === currentAnnotation.text);
              reassignBufferRef.current = {
                  ...reassignBufferRef.current,
                  [currentOwner?.key ?? '0']: currentAnnotation.text,
              };
              const savedText = reassignBufferRef.current[tool.key ?? ''];
              // Custom has no canonical text to reassign to, so with nothing
              // buffered yet, keep the annotation's current text — pressing 0
              // should hand the existing label to Custom for editing, not blank it.
              const newText = savedText !== undefined ? savedText : (isCustom ? currentAnnotation.text : tool.text);
              // A restored Custom text can coincidentally match a defined tool's
              // label; resolveLabelColor adopts that tool's color instead of the
              // generic Custom color (falls back to `tool.color` either way).
              const updated = annotations.map(a => a.id === boundAnnotationId
                  ? { ...a, text: newText, color: resolveLabelColor(newText, annotationTools, tool.color) }
                  : a
              );
              handleAnnotationsCommit(updated);
              setActiveToolKey(key);
              enterAnnotationToolLayer();
              if (isCustom) {
                  setTimeout(() => spectrogramRef.current?.focusAnnotationInput(boundAnnotationId), 0);
              }
          }
      } else if (activeToolKey === null && selection !== null) {
          addToolAnnotation(tool, selection);
          setActiveToolKey(key);
          enterAnnotationToolLayer();
      } else if (activeToolKey === key) {
          setActiveToolKey(null);
          activationStack.remove('annotationTool');
      } else {
          readyTool(key);
      }
  }, [annotationTools, boundAnnotationId, annotations, activeToolKey, selection, handleAnnotationsCommit, reassignBufferRef, activationStack, addToolAnnotation, enterAnnotationToolLayer, readyTool]);

  // Hotkey handlers. useHotkeys reads its bindings from a ref refreshed each
  // render, so these close over the latest state without a dep list.
  const selectAllOrAnnotateFullTrack = () => {
      if (displayDuration <= 0) return;
      const span = selectAllSpanAt(currentTimeRef.current);
      if (activeToolKey !== null) {
          const tool = annotationTools.find(t => t.key === activeToolKey);
          if (tool) {
              addToolAnnotation(tool, span);
              handleSelectionChange(span);
          }
      } else {
          handleSelectionChange(span);
      }
  };
  // Enter — deselect the current annotation, dropping the audio selection
  // region that selecting it created. No-op when nothing is selected.
  const deselectAnnotation = () => {
      if (selectedAnnotationId === null) return;
      setSelectedAnnotationId(null);
      setBoundAnnotationId(null);
      handleSelectionChange(null);
  };
  const deleteSelectedAnnotation = () => {
      if (!selectedAnnotationId) return;
      handleAnnotationsCommit(annotations.filter(a => a.id !== selectedAnnotationId));
      const wasBound = selectedAnnotationId === boundAnnotationId;
      setSelectedAnnotationId(null);
      if (wasBound) {
          handleSelectionChange(null);
          setBoundAnnotationId(null);
      }
  };
  // Mod+C — yank the selected annotation's label and span. Mod+V then recreates
  // that annotation starting at the playhead, its end trimmed to the track (or,
  // under a subset, to the segment the playhead sits in).
  const copyActiveAnnotation = () => {
      const ann = annotations.find(a => a.id === selectedAnnotationId)
          ?? annotations.find(a => a.id === boundAnnotationId);
      if (!ann) return;
      annotationClipboardRef.current = { text: ann.text, color: ann.color, duration: ann.end - ann.start };
  };
  // Mod+B — bind the selected annotation's label to the next free hotkey,
  // creating a tool for it if none carries that label yet. If the label already
  // sits on a hotkey, just ready that tool instead. Same bind action as the
  // annotation context menu's "Bind to hotkey".
  const bindSelectedAnnotationToHotkey = () => {
      const ann = annotations.find(a => a.id === selectedAnnotationId);
      if (!ann) return;
      const existing = annotationMatchingTool(ann, annotationTools);
      if (existing?.key != null) {
          readyTool(existing.key);
          return;
      }
      const key = bindAnnotationToHotkey(ann, annotationTools, {
          onBindHotkey: handleBindHotkey,
          onCreateTool: handleCreateTool,
      });
      // Ready the freshly bound tool so it's immediately usable.
      if (key) readyTool(key);
  };
  const pasteAnnotationAtPlayhead = () => {
      const clip = annotationClipboardRef.current;
      if (!clip || displayDuration <= 0) return;
      const startD = Math.max(0, Math.min(currentTimeRef.current, displayDuration));
      const endD = Math.min(timeline.clampToSpanOfDisplay(startD, startD + clip.duration), displayDuration);
      if (endD <= startD) return;
      const src = selectionToSource({ start: startD, end: endD });
      const color = resolveLabelColor(clip.text, annotationTools, clip.color ?? '#ffffff');
      // With the selection region on the pasted span — the same end state as
      // creating an annotation from a drag or a tool key.
      addBoundAnnotation(makeAnnotationFromLabel(clip.text, color, src.start, src.end));
      handleSelectionChange({ start: startD, end: endD });
  };

  // A bound selection carries its annotation with it, exactly as dragging the
  // selection's edges does (useSpectrogramInteraction). Keyboard extends stream
  // through `setAnnotations` and land in undo history once, when the burst
  // settles — otherwise every keypress in a held run would be its own undo step.
  // The draft ref carries the run: `annotations` is a render-old snapshot, and a
  // ramp takes many steps per render.

  // Keyed to its track: a draft still settling when the track switches must
  // not be committed onto the next track's annotations.
  const boundResizeDraftRef = useRef<{ trackPath: string | null; list: Annotation[] } | null>(null);
  const resizeBoundAnnotationTo = useCallback((sel: Selection | null) => {
    if (!boundAnnotationId || !sel) return;
    const src = selectionToSource(sel);
    const draft = boundResizeDraftRef.current;
    const base = draft && draft.trackPath === trackPathRef.current ? draft.list : annotations;
    const next = base.map(a =>
      a.id === boundAnnotationId ? { ...a, start: src.start, end: src.end } : a
    );
    boundResizeDraftRef.current = { trackPath: trackPathRef.current, list: next };
    setAnnotations(next);
  }, [boundAnnotationId, annotations, selectionToSource, setAnnotations]);
  const commitBoundAnnotationResize = useCallback(() => {
    const draft = boundResizeDraftRef.current;
    boundResizeDraftRef.current = null;
    if (draft && draft.trackPath === trackPathRef.current) handleAnnotationsCommit(draft.list);
  }, [handleAnnotationsCommit]);

  // A Shift+Arrow extend that builds a selection from scratch (nothing bound
  // yet) has no annotation to resize, so resizeBoundAnnotationTo is a no-op
  // through the whole gesture — mirroring a mouse drag, which stays a bare
  // selection until release. On settle, if a tool is readied, promote the
  // finished span into a new annotation from that tool, exactly as releasing
  // the mouse with a tool readied would (useSpectrogramInteraction's
  // commitNewAnnotation). An already-bound annotation just gets its resize
  // committed, as before.
  const handleExtendSettled = useCallback(() => {
    if (boundAnnotationId === null && activeToolKey !== null && selectionRef.current) {
      const tool = annotationTools.find(t => t.key === activeToolKey);
      if (tool) {
        addToolAnnotation(tool, selectionRef.current);
        return;
      }
    }
    commitBoundAnnotationResize();
  }, [boundAnnotationId, activeToolKey, annotationTools, selectionRef, addToolAnnotation, commitBoundAnnotationResize]);

  // Called by Toolbar time-field edits to sync the bound annotation's bounds.
  const handleToolbarAnnotationBoundsChange = useCallback((start: number, end: number) => {
    if (!boundAnnotationId) return;
    const old = annotations.find(a => a.id === boundAnnotationId);
    // Both times here are display; `old.start` is source, so the comparison is
    // made on the display axis the playhead is also on.
    if (old && Math.abs(currentTimeRef.current - timeline.toDisplay(old.start)) <= 0.5) {
      seek(start, false);
    }
    // Same resize the keyboard extend makes, committed immediately — a typed
    // edit is a single deliberate change, not a run of them.
    resizeBoundAnnotationTo({ start, end });
    commitBoundAnnotationResize();
  }, [boundAnnotationId, annotations, seek, timeline, resizeBoundAnnotationTo, commitBoundAnnotationResize]);


  // `S`: select mode (no annotation tool readied). Stack-equivalent to removing
  // the `annotationTool` entry — doesn't touch the selection, filter tool, or band.
  const selectMode = useCallback(() => {
      setActiveToolKey(null);
      activationStack.remove('annotationTool');
  }, [setActiveToolKey, activationStack]);

  return {
    readyTool, selectMode, handleToolActivate,
    selectAllOrAnnotateFullTrack, deselectAnnotation, deleteSelectedAnnotation,
    copyActiveAnnotation, pasteAnnotationAtPlayhead, bindSelectedAnnotationToHotkey,
    resizeBoundAnnotationTo, handleExtendSettled, handleToolbarAnnotationBoundsChange,
  };
}
