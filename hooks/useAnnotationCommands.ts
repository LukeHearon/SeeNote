import { useRef, useState, useEffect, useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { Annotation, AnnotationTool, Selection } from '../types';
import type { SpectrogramHandle } from '../components/Spectrogram';
import type { ActivationStackApi } from './useActivationStack';
import { makeAnnotationFromTool, makeAnnotationFromLabel } from '../utils/helpers';
import { resolveLabelColor } from '../utils/annotationTools';
import { bindAnnotationToHotkey, annotationMatchingTool } from '../utils/bindAnnotationHotkey';
import type { Timeline } from '../utils/subsetTimeline';
import { splitAnnotation } from '../utils/annotationSplit';
import { withDuration } from '../utils/multiAnnotationEdit';

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
  /** Setting a single selection (or null) also drops the multi-selection. */
  setSelectedAnnotationId: (id: string | null) => void;
  /** Annotations Shift-selected together (two or more, else empty). */
  multiSelectedIds: readonly string[];
  activationStack: ActivationStackApi;
  filterToolActive: boolean;
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
 * keyboard or the toolbar's time fields, and splitting annotations (K at the
 * playhead; Shift+K arms the Knife, which splits wherever an annotation is clicked).
 */
export function useAnnotationCommands({
  annotations, setAnnotations, handleAnnotationsCommit, annotationTools,
  activeToolKey, setActiveToolKey, selection, selectionRef,
  boundAnnotationId, setBoundAnnotationId, selectedAnnotationId, setSelectedAnnotationId, multiSelectedIds,
  activationStack, filterToolActive, setFilterToolActive, selectionToSource, selectAllSpanAt, timeline, displayDuration,
  currentTimeRef, trackPathRef, seek, handleSelectionChange, spectrogramRef,
  handleBindHotkey, handleCreateTool,
}: AnnotationCommandsParams) {
  // Knife (Shift+K): while armed, clicking an annotation splits it at the
  // click. Exclusive with the annotation tools and the filter tool — arming it
  // drops both, and readying either one disarms it. Its own activation-stack
  // layer, so Esc disarms it in turn.
  const [knifeArmed, setKnifeArmed] = useState(false);
  const disarmKnife = useCallback(() => {
      setKnifeArmed(false);
      activationStack.remove('knifeTool');
  }, [activationStack]);
  const toggleKnife = () => {
      if (knifeArmed) { disarmKnife(); return; }
      setActiveToolKey(null);
      activationStack.remove('annotationTool');
      setFilterToolActive(false);
      activationStack.remove('filterTool');
      setKnifeArmed(true);
      activationStack.pushIfAbsent('knifeTool');
  };
  useEffect(() => {
      if (activeToolKey !== null || filterToolActive) disarmKnife();
  }, [activeToolKey, filterToolActive, disarmKnife]);

  // Label + span (source seconds) yanked by Mod+C, replayed by Mod+V at the
  // playhead. Persists across track switches (the window stays mounted).
  const annotationClipboardRef = useRef<{ text: string; color?: string; duration: number } | null>(null);
  // Per-session text buffer for annotation tool reassignment, keyed by hotkey
  // digit ('0' = Custom): saves the label held under each tool while an
  // annotation is bound, so switching back to a prior tool restores the
  // previously-entered text. Cleared when the bound annotation is deselected.
  const reassignBufferRef = useRef<Record<string, string>>({});

  // Clear the reassign buffer whenever the bound annotation or the group changes (released or switched to another).
  // Keyed on the ids, not the array: it is rebuilt whenever annotations are, including by a relabel.
  const multiKey = multiSelectedIds.join(',');
  useEffect(() => { reassignBufferRef.current = {}; }, [boundAnnotationId, multiKey]);

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
      // What a tool key relabels: the Shift-selected group, else the bound annotation.
      const targetIds = multiSelectedIds.length > 0 ? multiSelectedIds : boundAnnotationId !== null ? [boundAnnotationId] : [];
      const lead = annotations.find(a => a.id === targetIds[0]);
      if (lead) {
          // The lead's current owner is whichever defined tool shares its
          // label; if none, it's a Custom label (bucket '0'). Stash its text
          // under that owner so toggling back restores what was typed.
          const currentOwner = annotationTools.find(t => t.key !== '0' && t.text === lead.text);
          reassignBufferRef.current = {
              ...reassignBufferRef.current,
              [currentOwner?.key ?? '0']: lead.text,
          };
          const savedText = reassignBufferRef.current[tool.key ?? ''];
          const targets = new Set(targetIds);
          const updated = annotations.map(a => {
              if (!targets.has(a.id)) return a;
              // Custom has no canonical text to reassign to, so with nothing
              // buffered yet, each keeps its current text — pressing 0 hands
              // the existing label to Custom for editing, not blanks it.
              const newText = savedText !== undefined ? savedText : (isCustom ? a.text : tool.text);
              // A restored Custom text can coincidentally match a defined tool's
              // label; resolveLabelColor adopts that tool's color instead of the
              // generic Custom color (falls back to `tool.color` either way).
              return { ...a, text: newText, color: resolveLabelColor(newText, annotationTools, tool.color) };
          });
          handleAnnotationsCommit(updated);
          setActiveToolKey(key);
          enterAnnotationToolLayer();
          if (isCustom && targetIds.length === 1) {
              setTimeout(() => spectrogramRef.current?.focusAnnotationInput(targetIds[0]), 0);
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
  }, [annotationTools, boundAnnotationId, multiSelectedIds, annotations, activeToolKey, selection, handleAnnotationsCommit, reassignBufferRef, activationStack, addToolAnnotation, enterAnnotationToolLayer, readyTool]);

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
      if (selectedAnnotationId === null && multiSelectedIds.length === 0) return;
      setSelectedAnnotationId(null);
      setBoundAnnotationId(null);
      handleSelectionChange(null);
  };
  const deleteSelectedAnnotation = () => {
      if (multiSelectedIds.length > 0) {
          const doomed = new Set(multiSelectedIds);
          handleAnnotationsCommit(annotations.filter(a => !doomed.has(a.id)));
          setSelectedAnnotationId(null);
          return;
      }
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


  // The toolbar's dur field while several annotations are selected: every one
  // takes the typed length, anchored on its start (it grows or shrinks at its
  // end), held inside its own span like a drag is.
  const handleToolbarMultiDuration = useCallback((dur: number) => {
    if (multiSelectedIds.length === 0 || !(dur > 0)) return;
    handleAnnotationsCommit(withDuration(annotations, new Set(multiSelectedIds), dur, a => {
      const ds = timeline.toDisplay(a.start);
      const de = Math.min(timeline.clampToSpanOfDisplay(ds, ds + dur), displayDuration);
      return selectionToSource({ start: ds, end: Math.max(ds, de) }).end;
    }));
  }, [multiSelectedIds, annotations, timeline, displayDuration, selectionToSource, handleAnnotationsCommit]);

  // `S`: select mode (no annotation tool readied). Stack-equivalent to removing
  // the `annotationTool` entry — doesn't touch the selection, filter tool, or band.
  // Also puts the Knife away — S means "back to plain selecting".
  const selectMode = useCallback(() => {
      setActiveToolKey(null);
      activationStack.remove('annotationTool');
      disarmKnife();
  }, [setActiveToolKey, activationStack, disarmKnife]);

  // Split annotation `id` at display time `t` — shared by K (at the playhead)
  // and the Knife (at the click). If it was selected or bound, `keep` says
  // which piece stays so, and a bound selection shrinks to that piece. K keeps
  // the right-hand piece, the one the playhead is in, so pressing it repeatedly
  // during playback keeps chopping; the Knife keeps the left (the original id).
  const splitAnnotationAt = useCallback((id: string, t: number, keep: 'left' | 'right') => {
      const r = splitAnnotation(annotations, id, timeline.toSource(t));
      if (!r) return;
      handleAnnotationsCommit(r.annotations);
      if (keep === 'left') {
          // The left piece keeps the id, so selection and binding stay put.
          const sel = selectionRef.current;
          if (boundAnnotationId === id && sel) handleSelectionChange({ start: sel.start, end: t });
          return;
      }
      if (selectedAnnotationId === id) setSelectedAnnotationId(r.right.id);
      if (boundAnnotationId === id) {
          setBoundAnnotationId(r.right.id);
          const sel = selectionRef.current;
          if (sel) handleSelectionChange({ start: t, end: sel.end });
      }
  }, [annotations, timeline, handleAnnotationsCommit, selectedAnnotationId, boundAnnotationId, selectionRef, handleSelectionChange]);
  // K — split the selected annotation at the playhead. No-op when nothing is
  // selected or the playhead isn't inside it.
  const splitSelectedAnnotationAtPlayhead = () => {
      const id = selectedAnnotationId ?? boundAnnotationId;
      if (id) splitAnnotationAt(id, currentTimeRef.current, 'right');
  };

  return {
    readyTool, selectMode, handleToolActivate,
    selectAllOrAnnotateFullTrack, deselectAnnotation, deleteSelectedAnnotation,
    copyActiveAnnotation, pasteAnnotationAtPlayhead, bindSelectedAnnotationToHotkey,
    resizeBoundAnnotationTo, handleExtendSettled, handleToolbarAnnotationBoundsChange, handleToolbarMultiDuration,
    knifeArmed, toggleKnife, disarmKnife, splitSelectedAnnotationAtPlayhead,
    // The Knife's click: keeps the left-hand piece selected / bound.
    knifeSplitAt: (id: string, t: number) => splitAnnotationAt(id, t, 'left'),
  };
}
