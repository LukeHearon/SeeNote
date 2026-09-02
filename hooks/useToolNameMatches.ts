import React, { useEffect, useRef, useState } from 'react';
import { AnnotationTool } from '../types';
import { matchToolsByText, ToolMatch } from '../utils/annotationTools';

// Backs a type-a-partial-name dropdown of matching annotation tools: the match
// list, a keyboard highlight, and scroll-into-view for the highlighted row.
// Shared by NewToolEntry (Add-tool field) and the inline annotation-label
// editor. Selection and the Enter/click wiring stay with the caller, since the
// two differ on what picking a match does.
//
// `initialActiveIndex` is -1 by default — nothing highlighted, so Enter is the
// caller's to interpret (commit the typed text as-is). NewToolEntry passes 0 to
// keep the first match highlighted on open.
export function useToolNameMatches(
  annotationTools: AnnotationTool[],
  query: string,
  open: boolean,
  initialActiveIndex = -1,
): {
  matches: ToolMatch[];
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  itemRefs: React.MutableRefObject<(HTMLElement | null)[]>;
  // Handles ArrowUp/ArrowDown when the dropdown is open; returns true if it
  // consumed the key.
  handleArrowKeys: (e: React.KeyboardEvent) => boolean;
} {
  const matches = matchToolsByText(annotationTools, query);
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const trimmed = query.trim();
  useEffect(() => { setActiveIndex(initialActiveIndex); }, [trimmed, initialActiveIndex]);
  useEffect(() => {
    if (open && activeIndex >= 0) itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const handleArrowKeys = (e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, matches.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, initialActiveIndex));
      return true;
    }
    return false;
  };

  return { matches, activeIndex, setActiveIndex, itemRefs, handleArrowKeys };
}
