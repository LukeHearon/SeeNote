import React, { useState, useEffect } from 'react';
import { startDragSession, useCollapsibleSidebar } from './useCollapsibleSidebar';
import { useSidebarSections, SidebarSectionsApi, SidebarSectionsState } from './useSidebarSections';

export interface PanelLayoutInitial {
  splitRatio: number;
  sidebarSections: SidebarSectionsState;
  leftPanelWidth: number;
  findPanelWidth: number;
}

export interface PanelLayoutApi {
  splitRatio: number;
  setSplitRatio: React.Dispatch<React.SetStateAction<number>>;
  /** Height weights + collapse state for the sidebar's stack of sections. */
  sidebarSections: SidebarSectionsApi;
  leftPanelWidth: number;
  setLeftPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  /** Width of the right-hand Find & Rename dock. Opening/closing it is the owner's business. */
  findPanelWidth: number;
  setFindPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  filePanelCollapsed: boolean;
  setFilePanelCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  videoCollapsed: boolean;
  setVideoCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  hideLabels: boolean;
  setHideLabels: React.Dispatch<React.SetStateAction<boolean>>;
  /** Pixel height of the collapsed video bar — consumed by the render. */
  VIDEO_COLLAPSED_BAR_PX: number;
  handleSplitDrag: (e: React.MouseEvent) => void;
  handleLeftPanelWidthDrag: (e: React.MouseEvent) => void;
  handleFindPanelWidthDrag: (e: React.MouseEvent) => void;
}

// Dragging the video/spectrogram divider above this ratio collapses the
// video pane to a bar (mirrors the file-panel drag-to-collapse, where the
// collapse threshold equals the expanded minimum). Kept in sync with the
// collapsed bar's pixel height so a drag back down resumes from the bar.
const VIDEO_COLLAPSE_MIN_RATIO = 0.2;
const VIDEO_COLLAPSED_BAR_PX = 32;
const LEFT_PANEL_COLLAPSE_THRESHOLD = 120;
const LEFT_PANEL_MAX_WIDTH = 480;
/** Width of the collapsed file-panel rail (w-10). */
const LEFT_PANEL_COLLAPSED_PX = 40;
// The find dock never collapses to a rail — it's closed outright — so these are
// just the bounds a drag clamps to.
const FIND_PANEL_MIN_WIDTH = 200;
const FIND_PANEL_MAX_WIDTH = 560;

/**
 * Panel sizing + drag handling for AnnotationWindow's resizable dividers (the
 * video/spectrogram split, the left panel's width, the right-hand find dock's
 * width, and — via useSidebarSections — the dividers between the sidebar's
 * stacked sections),
 * plus the H-held "hide labels" keyboard toggle. Initial sizes are passed in
 * by the owner.
 */
export function usePanelLayout(initial: PanelLayoutInitial): PanelLayoutApi {
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const [hideLabels, setHideLabels] = useState(false);

  const [splitRatio, setSplitRatio] = useState(initial.splitRatio);
  const sidebarSections = useSidebarSections(initial.sidebarSections);

  // The file panel's width + drag-to-collapse is the generic sidebar behaviour,
  // shared with the help guide's section rail.
  const {
    width: leftPanelWidth,
    setWidth: setLeftPanelWidth,
    collapsed: filePanelCollapsed,
    setCollapsed: setFilePanelCollapsed,
    handleWidthDrag: handleLeftPanelWidthDrag,
  } = useCollapsibleSidebar({
    initialWidth: initial.leftPanelWidth,
    minWidth: LEFT_PANEL_COLLAPSE_THRESHOLD,
    maxWidth: LEFT_PANEL_MAX_WIDTH,
    collapsedWidth: LEFT_PANEL_COLLAPSED_PX,
  });

  // Same behaviour mirrored onto the right edge for the find dock, minus the
  // drag-to-collapse: its own close button is the only way to dismiss it.
  const {
    width: findPanelWidth,
    setWidth: setFindPanelWidth,
    handleWidthDrag: handleFindPanelWidthDrag,
  } = useCollapsibleSidebar({
    initialWidth: initial.findPanelWidth,
    minWidth: FIND_PANEL_MIN_WIDTH,
    maxWidth: FIND_PANEL_MAX_WIDTH,
    collapsedWidth: FIND_PANEL_MIN_WIDTH,
    side: 'right',
    collapsible: false,
  });

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

  return {
    splitRatio,
    setSplitRatio,
    sidebarSections,
    leftPanelWidth,
    setLeftPanelWidth,
    findPanelWidth,
    setFindPanelWidth,
    filePanelCollapsed,
    setFilePanelCollapsed,
    videoCollapsed,
    setVideoCollapsed,
    hideLabels,
    setHideLabels,
    VIDEO_COLLAPSED_BAR_PX,
    handleSplitDrag,
    handleLeftPanelWidthDrag,
    handleFindPanelWidthDrag,
  };
}
