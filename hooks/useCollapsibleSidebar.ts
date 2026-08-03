import React, { useState } from 'react';

/**
 * Shared window-drag scaffold: wires a mousemove listener and a one-shot
 * mouseup that tears both down. Each handler supplies only its delta math.
 */
export function startDragSession(onMove: (e: MouseEvent) => void): void {
  const move = (e: MouseEvent) => onMove(e);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

export interface CollapsibleSidebarOptions {
  initialWidth: number;
  /** Expanded minimum, and the dragged width below which the panel collapses. */
  minWidth: number;
  maxWidth: number;
  /** Pixel width of the collapsed rail, so dragging back out resumes from it. */
  collapsedWidth: number;
}

export interface CollapsibleSidebar {
  width: number;
  setWidth: React.Dispatch<React.SetStateAction<number>>;
  collapsed: boolean;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  /** mousedown handler for the panel's outer-edge resize strip. */
  handleWidthDrag: (e: React.MouseEvent) => void;
}

/**
 * A left-hand panel that resizes by dragging its outer edge and collapses to a
 * rail when dragged past its minimum — the file panel's behaviour, factored out
 * so the help guide's section rail behaves the same way.
 *
 * Collapsing is drag-only by design; restoring is a button on the rail, so a
 * collapsed panel can't be dragged back open by accident.
 */
export function useCollapsibleSidebar({
  initialWidth,
  minWidth,
  maxWidth,
  collapsedWidth,
}: CollapsibleSidebarOptions): CollapsibleSidebar {
  const [width, setWidth] = useState(initialWidth);
  const [collapsed, setCollapsed] = useState(false);

  const handleWidthDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = collapsed ? collapsedWidth : width;
    startDragSession(moveEvent => {
      const newWidth = startWidth + (moveEvent.clientX - startX);
      if (newWidth < minWidth) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
        setWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
      }
    });
  };

  return { width, setWidth, collapsed, setCollapsed, handleWidthDrag };
}
