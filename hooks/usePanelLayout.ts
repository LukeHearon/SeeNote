import React, { useState, useEffect } from 'react';

export interface PanelLayoutInitial {
  splitRatio: number;
  leftPanelRatio: number;
  leftPanelWidth: number;
}

export interface PanelLayoutApi {
  splitRatio: number;
  setSplitRatio: React.Dispatch<React.SetStateAction<number>>;
  leftPanelRatio: number;
  setLeftPanelRatio: React.Dispatch<React.SetStateAction<number>>;
  leftPanelWidth: number;
  setLeftPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  filePanelCollapsed: boolean;
  setFilePanelCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  videoCollapsed: boolean;
  setVideoCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  hideLabels: boolean;
  setHideLabels: React.Dispatch<React.SetStateAction<boolean>>;
  /** Pixel height of the collapsed video bar — consumed by the render. */
  VIDEO_COLLAPSED_BAR_PX: number;
  handleSplitDrag: (e: React.MouseEvent) => void;
  handleLeftPanelDrag: (e: React.MouseEvent) => void;
  handleLeftPanelWidthDrag: (e: React.MouseEvent) => void;
}

// Dragging the video/spectrogram divider above this ratio collapses the
// video pane to a bar (mirrors the file-panel drag-to-collapse, where the
// collapse threshold equals the expanded minimum). Kept in sync with the
// collapsed bar's pixel height so a drag back down resumes from the bar.
const VIDEO_COLLAPSE_MIN_RATIO = 0.2;
const VIDEO_COLLAPSED_BAR_PX = 32;
const LEFT_PANEL_COLLAPSE_THRESHOLD = 120;

/**
 * Panel sizing + drag handling for AnnotationWindow's three resizable
 * dividers (video/spectrogram split, left-panel height, left-panel width),
 * plus the H-held "hide labels" keyboard toggle. Initial sizes are passed in
 * by the owner (same DEFAULT_* values as before).
 */
export function usePanelLayout(initial: PanelLayoutInitial): PanelLayoutApi {
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const [hideLabels, setHideLabels] = useState(false);

  const [splitRatio, setSplitRatio] = useState(initial.splitRatio);
  const [leftPanelRatio, setLeftPanelRatio] = useState(initial.leftPanelRatio);
  const [leftPanelWidth, setLeftPanelWidth] = useState(initial.leftPanelWidth);

  // H held → hide annotation fills/text (border stays). keyup restores them.
  useEffect(() => {
    const inInput = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      if (t.isContentEditable) return true;
      return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'h') return;
      if (e.repeat) return;
      if (inInput(e.target)) return;
      e.preventDefault();
      setHideLabels(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'h') return;
      setHideLabels(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Shared window-drag scaffold: wires a mousemove listener and a one-shot
  // mouseup that tears both down. Each handler supplies only its delta math.
  const startDragSession = (onMove: (e: MouseEvent) => void) => {
      const move = (e: MouseEvent) => onMove(e);
      const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
  };

  const handleSplitDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const totalHeight = window.innerHeight - 64;
      const startRatio = videoCollapsed ? VIDEO_COLLAPSED_BAR_PX / totalHeight : splitRatio;
      startDragSession((moveEvent) => {
          const delta = moveEvent.clientY - startY;
          const newRatio = startRatio + (delta / totalHeight);
          if (newRatio < VIDEO_COLLAPSE_MIN_RATIO) {
              setVideoCollapsed(true);
          } else {
              setVideoCollapsed(false);
              setSplitRatio(Math.min(0.8, newRatio));
          }
      });
  };

  const handleLeftPanelDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = leftPanelRatio;
      startDragSession((moveEvent) => {
          const delta = moveEvent.clientY - startY;
          const totalHeight = window.innerHeight - 64;
          let newRatio = Math.max(0.15, Math.min(0.85, startRatio + (delta / totalHeight)));
          // Soft snap: shift up by one divider height (h-2 = 8px) so tops align visually
          const dividerOffset = 8 / totalHeight;
          if (Math.abs(newRatio - (splitRatio - dividerOffset)) < 0.025) newRatio = splitRatio - dividerOffset;
          setLeftPanelRatio(newRatio);
      });
  };

  const handleLeftPanelWidthDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = filePanelCollapsed ? 40 : leftPanelWidth;
      startDragSession((moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const newWidth = startWidth + delta;
          if (newWidth < LEFT_PANEL_COLLAPSE_THRESHOLD) {
              setFilePanelCollapsed(true);
          } else {
              setFilePanelCollapsed(false);
              setLeftPanelWidth(Math.max(LEFT_PANEL_COLLAPSE_THRESHOLD, Math.min(480, newWidth)));
          }
      });
  };

  return {
    splitRatio,
    setSplitRatio,
    leftPanelRatio,
    setLeftPanelRatio,
    leftPanelWidth,
    setLeftPanelWidth,
    filePanelCollapsed,
    setFilePanelCollapsed,
    videoCollapsed,
    setVideoCollapsed,
    hideLabels,
    setHideLabels,
    VIDEO_COLLAPSED_BAR_PX,
    handleSplitDrag,
    handleLeftPanelDrag,
    handleLeftPanelWidthDrag,
  };
}
