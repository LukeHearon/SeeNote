import { Annotation, AnnotationTool } from '../types';
import { nextAvailableHotkey, pickNextToolColor } from '../constants';

// Bind the selected annotation's label to a hotkey — the shared logic behind
// the annotation context menu's "Bind to hotkey" item and the {mod}+B shortcut.
// If a tool already carries this label it's assigned to the next free key;
// otherwise a new tool is created on that key.

export interface BindAnnotationHotkeyHandlers {
  onBindHotkey: (toolId: string, key: string) => void;
  onCreateTool: (text: string, color: string, key?: string | null) => void;
}

/** The tool whose label matches this annotation, if any (never the Custom tool). */
export const annotationMatchingTool = (
  annotation: Pick<Annotation, 'text'>,
  tools: AnnotationTool[],
): AnnotationTool | undefined =>
  tools.find(t => t.key !== '0' && t.text.toLowerCase() === annotation.text.toLowerCase());

/** Whether {mod}+B / the context-menu item can act on this annotation right now. */
export const canBindAnnotationToHotkey = (
  annotation: Pick<Annotation, 'text'>,
  tools: AnnotationTool[],
): boolean => {
  if (!annotation.text) return false;
  const existing = annotationMatchingTool(annotation, tools);
  if (existing != null && existing.key !== null) return false; // already on a key
  return nextAvailableHotkey(tools) !== null;
};

/** Bind the annotation's label to the next free hotkey. Returns true if it acted. */
export const bindAnnotationToHotkey = (
  annotation: Pick<Annotation, 'text'>,
  tools: AnnotationTool[],
  handlers: BindAnnotationHotkeyHandlers,
): boolean => {
  if (!canBindAnnotationToHotkey(annotation, tools)) return false;
  const key = nextAvailableHotkey(tools)!;
  const existing = annotationMatchingTool(annotation, tools);
  if (existing) handlers.onBindHotkey(existing.id, key);
  else handlers.onCreateTool(annotation.text, pickNextToolColor(tools), key);
  return true;
};
