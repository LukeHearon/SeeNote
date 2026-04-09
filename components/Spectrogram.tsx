import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Label, SpectrogramSettings, LabelConfig } from '../types';
import { drawSpectrogramChunk } from '../utils/audioProcessing';
import { formatTime, calculateLabelLayers } from '../utils/helpers';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { MIN_ZOOM_SEC } from '../constants';
import { X, ChevronLeft, ChevronRight, Pencil } from 'lucide-react';

// Format time for the spectrogram ruler.
// viewSpan: the total visible time range in seconds (used to decide whether to show hours).
function formatRulerTime(s: number, timeStep: number, viewSpan: number): string {
  if (timeStep < 1) {
    return `${s.toFixed(2)}s`;
  }
  const totalSec = Math.round(s);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;

  const showHours = viewSpan >= 3600;

  if (showHours) {
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  } else if (totalSec >= 60 || timeStep >= 60) {
    return `${m}m${String(sec).padStart(2, '0')}s`;
  } else {
    return `${sec}s`;
  }
}

interface SelectionRegion {
  start: number;
  end: number;
}

interface SpectrogramProps {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
  cacheVersion: number;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isProcessing: boolean;
  fileIdent: string | null;
  settings: SpectrogramSettings;
  labels: Label[];
  selectedLabelId: string | null;
  // null = Selection Mode (no label config active)
  activeLabelConfig: LabelConfig | null;
  labelConfigs: LabelConfig[];
  selectionRegion: SelectionRegion | null;
  onSeek: (time: number) => void;
  onLabelsChange: (labels: Label[]) => void;
  onLabelsCommit: (labels: Label[]) => void;
  onSelectLabel: (id: string | null) => void;
  onSelectionChange: (region: SelectionRegion | null) => void;
  onZoomChange: (newWindowSize: number) => void;
}

// Helpers for scale mapping (duplicated locally for Y-axis calculation)
const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);

const Spectrogram: React.FC<SpectrogramProps> = ({
  chunkCache,
  sampleRate,
  cacheVersion,
  currentTime,
  duration,
  isPlaying,
  isProcessing,
  fileIdent,
  settings,
  labels,
  selectedLabelId,
  activeLabelConfig,
  labelConfigs,
  selectionRegion,
  onSeek,
  onLabelsChange,
  onLabelsCommit,
  onSelectLabel,
  onSelectionChange,
  onZoomChange
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Overlay canvas: draws axis, playhead, ident, and selection darkening.
  // Must be above label HTML divs (z-30 > labels z-10/20).
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);

  // Internal scroll state (in pixels)
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollLeftRef = useRef(0);
  useEffect(() => { scrollLeftRef.current = scrollLeft; }, [scrollLeft]);
  const [dragStart, setDragStart] = useState<{ x: number; scroll: number } | null>(null);

  // Hovered label id for hover effects (delete button, pencil icon)
  const [hoveredLabelId, setHoveredLabelId] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for input focus (pencil icon click)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pencilClickedId, setPencilClickedId] = useState<string | null>(null);
  // Tracks which label is currently in text-edit mode (only via pencil)
  const [editingInputId, setEditingInputId] = useState<string | null>(null);

  const handleLabelMouseEnter = useCallback((id: string) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHoveredLabelId(id);
  }, []);

  const handleLabelMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => setHoveredLabelId(null), 300);
  }, []);

  // Focus input when pencil is clicked
  useEffect(() => {
    if (pencilClickedId) {
      inputRefs.current[pencilClickedId]?.focus();
      setPencilClickedId(null);
    }
  }, [pencilClickedId]);

  // Interaction State (Labels — only when activeLabelConfig !== null)
  const [creatingLabel, setCreatingLabel] = useState<{ start: number; current: number } | null>(null);
  const [resizingLabel, setResizingLabel] = useState<{ id: string; side: 'start' | 'end'; originalTime: number } | null>(null);
  const [draggedLabel, setDraggedLabel] = useState<{ id: string; startOffset: number } | null>(null);

  // Selection Mode interaction state
  const [creatingSelection, setCreatingSelection] = useState<{ start: number; current: number } | null>(null);
  const [resizingSelectionHandle, setResizingSelectionHandle] = useState<'start' | 'end' | null>(null);

  // Annotation-bound selection: clicking center of a label binds selection to it.
  // Null means no bound annotation.
  const [boundAnnotationId, setBoundAnnotationId] = useState<string | null>(null);

  // Track mousedown on label center to distinguish click vs drag
  const clickDownRef = useRef<{ x: number; y: number; labelId: string; pointerTime: number } | null>(null);

  const requestRef = useRef<number | null>(null);
  const pendingLabelsRef = useRef<Label[]>(labels);

  const pixelsPerSecond = useMemo(() => {
     if (!containerRef.current) return 100;
     return containerRef.current.clientWidth / settings.windowSize;
  }, [settings.windowSize, containerRef.current?.clientWidth]);

  // Reset scroll position to 0 when switching files
  useEffect(() => {
    setScrollLeft(0);
  }, [fileIdent]);

  // Sync scroll with playback — center the playhead once it reaches the center of the
  // currently-visible window. The trigger is proportional (center of screen), so it
  // behaves identically regardless of zoom level.
  useEffect(() => {
      if (isPlaying && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          const pps = containerWidth / settings.windowSize;
          const curScroll = scrollLeftRef.current;
          const visibleCenterTime = (curScroll + containerWidth / 2) / pps;
          if (currentTime >= visibleCenterTime) {
              const targetScroll = currentTime * pps - containerWidth / 2;
              setScrollLeft(Math.max(0, targetScroll));
          }
      }
  }, [isPlaying, currentTime, settings.windowSize]);

  // Main canvas: draws spectrogram data only.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // The spectrogram canvas starts 50px into the container (Y-axis occupies the left 50px).
    const yAxisWidth = 50;
    const startTime = (scrollLeft + yAxisWidth) / pixelsPerSecond;
    const timePerPixel = 1 / pixelsPerSecond;
    const endTime = startTime + (width * timePerPixel);

    if (chunkCache && duration > 0) {
        const visibleDuration = endTime - startTime;
        const activeTier = chunkCache.selectTier(visibleDuration, width);
        chunkCache.prefetchViewport(startTime, endTime, activeTier.tier);

        let nFreqBins = settings.fftSize / 2;
        for (let px = 0; px < width; px++) {
            const t = startTime + px * timePerPixel;
            const result = chunkCache.getChunkWithFallback(t, activeTier.tier);
            if (result) { nFreqBins = result.chunk.nFreqBins; break; }
        }

        const viewportData = new Uint8Array(width * nFreqBins);

        for (let px = 0; px < width; px++) {
            const tStart = startTime + px * timePerPixel;
            // Don't fill pixels past the end of the file — prevents the last column
            // from being stretched across the remaining canvas area.
            if (tStart >= duration) continue;
            const tEnd = startTime + (px + 1) * timePerPixel;
            const tMid = (tStart + tEnd) / 2;

            const result = chunkCache.getChunkWithFallback(tMid, activeTier.tier);
            if (!result) continue;
            const { chunk } = result;
            if (chunk.nCols === 0 || chunk.actualDurationSec <= 0) continue;

            const bins = Math.min(nFreqBins, chunk.nFreqBins);
            const dstOffset = px * nFreqBins;

            let colStart = Math.floor(((tStart - chunk.startSec) / chunk.actualDurationSec) * chunk.nCols);
            let colEnd = Math.ceil(((tEnd - chunk.startSec) / chunk.actualDurationSec) * chunk.nCols);
            colStart = Math.max(0, colStart);
            colEnd = Math.min(chunk.nCols, colEnd);

            if (colEnd - colStart <= 1) {
                const col = Math.max(0, Math.min(chunk.nCols - 1,
                    Math.floor(((tMid - chunk.startSec) / chunk.actualDurationSec) * chunk.nCols)));
                const srcOffset = col * chunk.nFreqBins;
                viewportData.set(chunk.data.subarray(srcOffset, srcOffset + bins), dstOffset);
            } else {
                for (let col = colStart; col < colEnd; col++) {
                    const srcOffset = col * chunk.nFreqBins;
                    for (let bin = 0; bin < bins; bin++) {
                        const val = chunk.data[srcOffset + bin];
                        if (val > viewportData[dstOffset + bin]) {
                            viewportData[dstOffset + bin] = val;
                        }
                    }
                }
            }
        }

        drawSpectrogramChunk(
            ctx, viewportData, width, nFreqBins,
            startTime, timePerPixel, duration, width, height,
            settings.intensity, settings.contrast,
            settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale
        );
    } else if (!chunkCache && duration > 0 && !isProcessing) {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < width; i += 50) {
            ctx.moveTo(i, 0); ctx.lineTo(i, height);
        }
        ctx.stroke();
        ctx.fillStyle = '#334155';
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Spectrogram Unavailable', width / 2, height / 2);
    }
  }, [chunkCache, sampleRate, cacheVersion, scrollLeft, pixelsPerSecond, duration, settings.intensity, settings.contrast, settings.fftSize, settings.minFreq, settings.maxFreq, settings.frequencyScale, isProcessing]);

  // Overlay canvas: axis, playhead, ident, and selection region darkening.
  // Rendered above label HTML divs (z-30).
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const startTime = scrollLeft / pixelsPerSecond;
    const timePerPixel = 1 / pixelsPerSecond;
    const endTime = startTime + (width * timePerPixel);

    // 1. Selection region darkening — draw FIRST so other elements render on top
    // Only show creating-selection darkening once the mouse has moved (not on initial mousedown)
    const isDraggingSelection = creatingSelection && Math.abs(creatingSelection.current - creatingSelection.start) > 0.001;
    const activeSelection = isDraggingSelection
      ? { start: Math.min(creatingSelection.start, creatingSelection.current), end: Math.max(creatingSelection.start, creatingSelection.current) }
      : selectionRegion;

    if (activeSelection) {
      const selStartX = Math.max(0, (activeSelection.start * pixelsPerSecond) - scrollLeft);
      const selEndX = Math.min(width, (activeSelection.end * pixelsPerSecond) - scrollLeft);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      // Left dark region
      if (selStartX > 0) {
        ctx.fillRect(0, 0, selStartX, height);
      }
      // Right dark region
      if (selEndX < width) {
        ctx.fillRect(selEndX, 0, width - selEndX, height);
      }
    }

    // 2. Draw Playhead Line
    const playheadX = (currentTime * pixelsPerSecond) - scrollLeft;
    if (playheadX >= 0 && playheadX <= width) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();
    }

    // 3. Draw Frequency Axis (Left)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(0, 0, 50, height);
    ctx.beginPath();
    ctx.moveTo(50, 0);
    ctx.lineTo(50, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const renderTick = (freq: number) => {
         let y = 0;
         if (settings.frequencyScale === 'linear') {
             const pct = (freq - settings.minFreq) / (settings.maxFreq - settings.minFreq);
             y = height - (pct * height);
         } else if (settings.frequencyScale === 'log') {
             const minSafe = Math.max(settings.minFreq, 1);
             const pct = Math.log(freq / minSafe) / Math.log(settings.maxFreq / minSafe);
             y = height - (pct * height);
         } else if (settings.frequencyScale === 'mel') {
             const minM = toMel(settings.minFreq);
             const maxM = toMel(settings.maxFreq);
             const m = toMel(freq);
             const pct = (m - minM) / (maxM - minM);
             y = height - (pct * height);
         }

         if (y >= 0 && y <= height) {
             ctx.beginPath();
             ctx.moveTo(45, y);
             ctx.lineTo(50, y);
             ctx.strokeStyle = 'rgba(255,255,255,0.5)';
             ctx.stroke();

             let label = freq.toString();
             if (freq >= 1000) {
                 label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
             }
             ctx.fillText(label, 42, y);
         }
    };

    if (settings.frequencyScale === 'log') {
        let mag = 10;
        while (mag < settings.maxFreq) {
            [1, 2, 5].forEach(mult => {
                const freq = mag * mult;
                if (freq >= settings.minFreq && freq <= settings.maxFreq) renderTick(freq);
            });
            mag *= 10;
        }
    } else {
        const range = settings.maxFreq - settings.minFreq;
        if (range > 0) {
            const roughStep = range / 8;
            const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
            let step = magnitude;
            if (roughStep / step > 5) step *= 5;
            else if (roughStep / step > 2) step *= 2;
            const firstTick = Math.ceil(settings.minFreq / step) * step;
            for (let freq = firstTick; freq <= settings.maxFreq; freq += step) {
                renderTick(freq);
            }
        }
    }

    // 4. Draw Time Ruler
    const timeRange = endTime - startTime;
    let timeStep = 1;
    if (timeRange > 36000) timeStep = 3600;
    else if (timeRange > 7200) timeStep = 600;
    else if (timeRange > 1200) timeStep = 120;
    else if (timeRange > 300) timeStep = 60;
    else if (timeRange > 60) timeStep = 10;
    else if (timeRange > 30) timeStep = 5;
    else if (timeRange > 10) timeStep = 2;
    else if (timeRange > 2) timeStep = 1;
    else timeStep = 0.25;

    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const firstTimeTick = Math.floor(startTime / timeStep) * timeStep;
    for (let s = firstTimeTick; s <= endTime; s += timeStep) {
        if (s < 0) continue;
        const x = (s * pixelsPerSecond) - scrollLeft;
        if (x >= 50 && x <= width + 50) {
            ctx.beginPath();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.moveTo(x, height);
            ctx.lineTo(x, height - 8);
            ctx.stroke();

            const timeStr = formatRulerTime(s, timeStep, timeRange);
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 3;
            ctx.strokeText(timeStr, x, height - 10);
            ctx.fillStyle = 'white';
            ctx.fillText(timeStr, x, height - 10);
        }
    }

    // 5. Draw ident text at top of spectrogram
    if (fileIdent) {
      ctx.save();
      ctx.font = 'bold 12px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(fileIdent, 58, 6);
      ctx.restore();
    }
  }, [scrollLeft, pixelsPerSecond, currentTime, settings.minFreq, settings.maxFreq, settings.frequencyScale, fileIdent, selectionRegion, creatingSelection]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(() => { draw(); drawOverlay(); });
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [draw, drawOverlay]);

  // Handle Resize — keep both canvases in sync with container dimensions
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        if (canvasRef.current) {
          canvasRef.current.width = Math.max(1, width - 50);
          canvasRef.current.height = height;
        }
        if (overlayCanvasRef.current) {
          overlayCanvasRef.current.width = width;
          overlayCanvasRef.current.height = height;
        }
        draw();
        drawOverlay();
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [draw, drawOverlay]);

  // --- Annotation navigation ---

  const sortedLabels = useMemo(() => [...labels].sort((a, b) => a.start - b.start), [labels]);

  const canGoPrev = sortedLabels.length > 0 && sortedLabels.some(l => l.start < currentTime - 0.05);
  const canGoNext = sortedLabels.length > 0 && sortedLabels.some(l => l.start > currentTime + 0.05);

  const scrollToAnnotation = useCallback((annotStart: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const targetScrollLeft = (annotStart * pixelsPerSecond) - (containerWidth * 0.25);
    setScrollLeft(Math.max(0, targetScrollLeft));
  }, [pixelsPerSecond]);

  const goToPrevAnnotation = useCallback(() => {
    const prev = [...sortedLabels].reverse().find(l => l.start < currentTime - 0.05);
    if (prev) {
      onSeek(prev.start);
      scrollToAnnotation(prev.start);
    }
  }, [sortedLabels, currentTime, onSeek, scrollToAnnotation]);

  const goToNextAnnotation = useCallback(() => {
    const next = sortedLabels.find(l => l.start > currentTime + 0.05);
    if (next) {
      onSeek(next.start);
      scrollToAnnotation(next.start);
    }
  }, [sortedLabels, currentTime, onSeek, scrollToAnnotation]);

  // Keyboard shortcuts: ; = prev, ' = next, Escape = clear bound/selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ';') {
        e.preventDefault();
        goToPrevAnnotation();
      } else if (e.key === "'") {
        e.preventDefault();
        goToNextAnnotation();
      } else if (e.key === 'Escape') {
        setBoundAnnotationId(null);
        onSelectionChange(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goToPrevAnnotation, goToNextAnnotation, onSelectionChange]);

  // --- Interaction Handlers ---

  const getPointerTime = (e: React.MouseEvent) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const absoluteX = x + scrollLeft;
    const t = absoluteX / pixelsPerSecond;
    return Math.max(0, Math.min(t, duration));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      setDragStart({ x: e.clientX, scroll: scrollLeft });
      return;
    }

    if ((e.target as HTMLElement).closest('input') || (e.target as HTMLElement).closest('button')) return;

    // Prevent interaction if clicking on the frequency axis area
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && (e.clientX - rect.left) < 50) return;

    const labelItem = (e.target as HTMLElement).closest('.label-item');
    if (!labelItem) {
      // Clicking bare spectrogram
      const t = getPointerTime(e);

      if (activeLabelConfig === null) {
        // Selection Mode: single click seeks and clears selection
        onSelectLabel(null);
        setBoundAnnotationId(null);
        onSelectionChange(null);
        onSeek(t);
        // Start tracking in case user drags (creates selection)
        setCreatingSelection({ start: t, current: t });
      } else {
        // Label Mode: start annotation creation
        onSelectLabel(null);
        setBoundAnnotationId(null);
        const t2 = getPointerTime(e);
        setCreatingLabel({ start: t2, current: t2 });
        onSeek(t2);
      }
    }
    // Label center clicks are handled in the label onMouseDown handler
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragStart) {
      const delta = dragStart.x - e.clientX;
      const containerWidth = containerRef.current?.clientWidth || 0;
      const overrunPixels = containerWidth * 0.4;
      const maxScroll = Math.max(0, (duration * pixelsPerSecond) - containerWidth + overrunPixels);
      setScrollLeft(Math.max(0, Math.min(dragStart.scroll + delta, maxScroll)));
      return;
    }

    const t = getPointerTime(e);

    // Check if we should convert a pending label click into a drag
    if (clickDownRef.current) {
      const dx = e.clientX - clickDownRef.current.x;
      const dy = e.clientY - clickDownRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 5) {
        // Convert to drag
        const dragLabel = labels.find(l => l.id === clickDownRef.current!.labelId);
        if (dragLabel) {
          setDraggedLabel({ id: clickDownRef.current.labelId, startOffset: clickDownRef.current.pointerTime - dragLabel.start });
        }
        clickDownRef.current = null;
      }
      return;
    }

    if (creatingLabel) {
      setCreatingLabel({ ...creatingLabel, current: t });
      return;
    }

    if (creatingSelection) {
      setCreatingSelection({ ...creatingSelection, current: t });
      return;
    }

    if (resizingLabel) {
      const updated = labels.map(l => {
        if (l.id === resizingLabel.id) {
          if (resizingLabel.side === 'start') return { ...l, start: Math.min(t, l.end - 0.05) };
          return { ...l, end: Math.max(t, l.start + 0.05) };
        }
        return l;
      });
      pendingLabelsRef.current = updated;
      onLabelsChange(updated);
      // If resizing a bound annotation, update selection region to match
      if (resizingLabel.id === boundAnnotationId) {
        const updatedLabel = updated.find(l => l.id === resizingLabel.id);
        if (updatedLabel) {
          onSelectionChange({ start: updatedLabel.start, end: updatedLabel.end });
        }
      }
      return;
    }

    if (draggedLabel) {
       const updated = labels.map(l => {
           if (l.id === draggedLabel.id) {
               const dur = l.end - l.start;
               const newStart = Math.max(0, t - draggedLabel.startOffset);
               return { ...l, start: newStart, end: newStart + dur };
           }
           return l;
       });
       pendingLabelsRef.current = updated;
       onLabelsChange(updated);
       return;
    }

    if (resizingSelectionHandle && selectionRegion) {
      let newStart = selectionRegion.start;
      let newEnd = selectionRegion.end;
      if (resizingSelectionHandle === 'start') {
        newStart = Math.min(t, selectionRegion.end - 0.05);
      } else {
        newEnd = Math.max(t, selectionRegion.start + 0.05);
      }
      onSelectionChange({ start: newStart, end: newEnd });
      // If there's a bound annotation, update its extent to match
      if (boundAnnotationId) {
        const updated = labels.map(l => {
          if (l.id === boundAnnotationId) return { ...l, start: newStart, end: newEnd };
          return l;
        });
        pendingLabelsRef.current = updated;
        onLabelsChange(updated);
      }
    }
  };

  const handleMouseUp = (e?: React.MouseEvent) => {
    if (dragStart) setDragStart(null);

    // Pending label click (no significant movement) → annotation-bound selection
    if (clickDownRef.current) {
      const annotation = labels.find(l => l.id === clickDownRef.current!.labelId);
      if (annotation) {
        setBoundAnnotationId(annotation.id);
        onSelectionChange({ start: annotation.start, end: annotation.end });
        onSelectLabel(annotation.id);
      }
      clickDownRef.current = null;
    }

    if (creatingLabel) {
      const start = Math.min(creatingLabel.start, creatingLabel.current);
      const end = Math.max(creatingLabel.start, creatingLabel.current);
      if (end - start > 0.05 && activeLabelConfig !== null) {
        const id = Math.random().toString(36).substr(2, 9);
        const isActiveCustom = activeLabelConfig.key === "0";
        const newLabel: Label = {
            id,
            configId: activeLabelConfig.key,
            start,
            end,
            text: isActiveCustom ? "" : activeLabelConfig.text,
            color: activeLabelConfig.color
        };
        const committed = [...labels, newLabel];
        onLabelsCommit(committed);
        onSelectLabel(id);
      }
      setCreatingLabel(null);
    }

    if (creatingSelection) {
      const start = Math.min(creatingSelection.start, creatingSelection.current);
      const end = Math.max(creatingSelection.start, creatingSelection.current);
      if (end - start > 0.05) {
        onSelectionChange({ start, end });
        setBoundAnnotationId(null);
      } else {
        // Very small drag = treat as click; selection already cleared in mousedown
        onSelectionChange(null);
      }
      setCreatingSelection(null);
    }

    if (resizingLabel) {
      onLabelsCommit(pendingLabelsRef.current);
      setResizingLabel(null);
    }

    if (draggedLabel) {
      onLabelsCommit(pendingLabelsRef.current);
      setDraggedLabel(null);
    }

    if (resizingSelectionHandle) {
      if (boundAnnotationId && pendingLabelsRef.current.length > 0) {
        onLabelsCommit(pendingLabelsRef.current);
      }
      setResizingSelectionHandle(null);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        if (!containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const timeAtMouse = (scrollLeft + mouseX) / pixelsPerSecond;

        const zoomFactor = 1.1;
        const direction = e.deltaY > 0 ? 1 : -1;

        let newWindowSize = settings.windowSize * (direction > 0 ? zoomFactor : 1 / zoomFactor);
        newWindowSize = Math.max(MIN_ZOOM_SEC, Math.min(newWindowSize, duration || 86400));

        const containerWidth = containerRef.current.clientWidth;
        const newPixelsPerSecond = containerWidth / newWindowSize;

        let newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX;
        // Allow scrolling 40% of the view past the end of the file so the user can
        // center late events or zoom out with the end visible.
        const overrunPixels = containerWidth * 0.4;
        const maxScroll = Math.max(0, (duration * newPixelsPerSecond) - containerWidth + overrunPixels);
        newScrollLeft = Math.max(0, Math.min(newScrollLeft, maxScroll));

        setScrollLeft(newScrollLeft);
        onZoomChange(newWindowSize);
      } else {
          const panAmount = e.deltaY + e.deltaX;
          const containerWidth = containerRef.current?.clientWidth || 0;
          const overrunPixels = containerWidth * 0.4;
          const maxScroll = Math.max(0, (duration * pixelsPerSecond) - containerWidth + overrunPixels);
          setScrollLeft(prev => Math.max(0, Math.min(prev + panAmount, maxScroll)));
      }
  };

  const layeredLabels = useMemo(() => calculateLabelLayers(labels), [labels]);

  // Overlay for annotation being created (label mode)
  const renderCreatingOverlay = () => {
    if (!creatingLabel || activeLabelConfig === null) return null;
    const s = Math.min(creatingLabel.start, creatingLabel.current);
    const eTime = Math.max(creatingLabel.start, creatingLabel.current);
    const left = (s * pixelsPerSecond) - scrollLeft;
    const width = ((eTime - s) * pixelsPerSecond);

    return (
        <div
            className="absolute top-0 bottom-0 bg-white/20 border-l border-r border-white/50 pointer-events-none"
            style={{ left: `${left}px`, width: `${width}px` }}
        >
            <span className="absolute -top-6 left-0 text-xs bg-black/80 px-1 rounded text-white">{formatTime(s)}</span>
            <span className="absolute -top-6 right-0 text-xs bg-black/80 px-1 rounded text-white">{formatTime(eTime)}</span>
        </div>
    );
  };

  // Render selection region handles (draggable)
  const renderSelectionHandles = () => {
    const activeSelection = selectionRegion;
    if (!activeSelection || creatingSelection) return null;

    const leftX = (activeSelection.start * pixelsPerSecond) - scrollLeft;
    const rightX = (activeSelection.end * pixelsPerSecond) - scrollLeft;
    const containerWidth = containerRef.current?.clientWidth ?? 1000;

    return (
      <>
        {/* Left handle */}
        {leftX >= 0 && leftX <= containerWidth && (
          <div
            className="absolute top-0 bottom-0 w-2 bg-white/60 hover:bg-white/90 cursor-ew-resize"
            style={{ left: `${leftX - 1}px`, zIndex: 15 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setResizingSelectionHandle('start');
            }}
          />
        )}
        {/* Right handle */}
        {rightX >= 0 && rightX <= containerWidth && (
          <div
            className="absolute top-0 bottom-0 w-2 bg-white/60 hover:bg-white/90 cursor-ew-resize"
            style={{ left: `${rightX - 1}px`, zIndex: 15 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setResizingSelectionHandle('end');
            }}
          />
        )}
      </>
    );
  };

  return (
    <div
        ref={containerRef}
        className="relative w-full h-full bg-slate-900 overflow-hidden cursor-crosshair select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => handleMouseUp()}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
    >
      {/* Layer 1: spectrogram canvas (bottom) — starts at x=50, past the Y-axis */}
      <canvas ref={canvasRef} className="absolute top-0 h-full pointer-events-none" style={{ left: '50px', width: 'calc(100% - 50px)' }} />

      {/* Blurred placeholder overlay during spectrogram generation */}
      {isProcessing && (
        <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              background: 'repeating-linear-gradient(180deg, rgba(71,85,105,0.35) 0px, rgba(30,41,59,0.2) 6px, rgba(51,65,85,0.3) 6px, rgba(15,23,42,0.15) 14px)',
              filter: 'blur(6px)',
              transform: 'scale(1.06)',
            }}
          />
          <div className="absolute inset-0 bg-slate-900/60" />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-slate-400 text-xs bg-slate-900/70 px-3 py-1 rounded tracking-wide">Generating spectrogram…</span>
          </div>
        </div>
      )}

      {/* Layer 2: label HTML divs and selection handles */}
      <div ref={interactionRef} className="absolute top-0 left-0 w-full h-full">
         {layeredLabels.map((l) => {
             const left = (l.start * pixelsPerSecond) - scrollLeft;
             const width = (l.end - l.start) * pixelsPerSecond;
             const isSelected = selectedLabelId === l.id;
             const isBound = boundAnnotationId === l.id;

             if (left + width < 0 || left > (containerRef.current?.clientWidth || 1000)) return null;

             const top = 10 + ((l.layerIndex || 0) * 35);

             const baseColor = l.color || "#ffffff";
             const isWhite = baseColor.toLowerCase() === "#ffffff" || baseColor.toLowerCase() === "#fff";

             const styleVars = isWhite ? {
                 borderColor: isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.8)',
                 bgColor: isSelected ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.15)',
                 textColor: '#ffffff'
             } : {
                 borderColor: baseColor,
                 bgColor: isSelected ? `${baseColor}99` : `${baseColor}66`,
                 textColor: baseColor
             };

             const isHovered = hoveredLabelId === l.id;

             return (
                 <div
                    key={l.id}
                    className="label-item absolute rounded transition-colors duration-200"
                    style={{
                        left: `${left}px`,
                        width: `${Math.max(2, width)}px`,
                        top: `${top}px`,
                        height: '30px',
                        border: `${isBound ? '2px' : '1px'} solid ${isBound ? 'white' : styleVars.borderColor}`,
                        backgroundColor: styleVars.bgColor,
                        boxShadow: isBound ? '0 0 0 2px rgba(255,255,255,0.4)' : '0 2px 4px rgba(0,0,0,0.5)',
                        zIndex: isSelected ? 20 : 10
                    }}
                    onMouseEnter={() => handleLabelMouseEnter(l.id)}
                    onMouseLeave={handleLabelMouseLeave}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        // Middle Click Delete
                        if (e.button === 1) {
                            e.preventDefault();
                            onLabelsCommit(labels.filter(lb => lb.id !== l.id));
                            if (isSelected) onSelectLabel(null);
                            if (boundAnnotationId === l.id) {
                              setBoundAnnotationId(null);
                              onSelectionChange(null);
                            }
                            return;
                        }
                        onSelectLabel(l.id);
                        // Track for click vs drag detection
                        clickDownRef.current = { x: e.clientX, y: e.clientY, labelId: l.id, pointerTime: getPointerTime(e) };
                    }}
                 >
                    {/* Left resize handle */}
                    <div
                        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            clickDownRef.current = null;
                            onSelectLabel(l.id);
                            setResizingLabel({ id: l.id, side: 'start', originalTime: l.start });
                        }}
                    >
                        {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
                    </div>
                    {/* Right resize handle */}
                    <div
                        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            clickDownRef.current = null;
                            onSelectLabel(l.id);
                            setResizingLabel({ id: l.id, side: 'end', originalTime: l.end });
                        }}
                    >
                        {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
                    </div>

                    {width > 30 ? (
                        <input
                            ref={(el) => { inputRefs.current[l.id] = el; }}
                            type="text"
                            value={l.text}
                            onChange={(e) => {
                                const newText = e.target.value;
                                const newLabels = labels.map(lb => {
                                    if (lb.id === l.id) {
                                        const matchingConfig = labelConfigs.find(c => c.text.toLowerCase() === newText.toLowerCase() && c.key !== "0");
                                        if (matchingConfig) {
                                             return { ...lb, text: matchingConfig.text, configId: matchingConfig.key, color: matchingConfig.color };
                                        }
                                        if (lb.configId !== "0" && lb.color !== "#ffffff" && lb.text !== newText) {
                                            return { ...lb, text: newText, configId: "0", color: "#ffffff" };
                                        }
                                        return { ...lb, text: newText };
                                    }
                                    return lb;
                                });
                                pendingLabelsRef.current = newLabels;
                                onLabelsChange(newLabels);
                            }}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') {
                                    onSelectLabel(null);
                                    (e.target as HTMLInputElement).blur();
                                }
                                if (e.key === 'Escape') {
                                    (e.target as HTMLInputElement).blur();
                                }
                            }}
                            onBlur={() => {
                                setEditingInputId(null);
                                if (l.text.trim() === "") {
                                    const filtered = labels.filter(lb => lb.id !== l.id);
                                    onLabelsCommit(filtered);
                                    onSelectLabel(null);
                                } else {
                                    onLabelsCommit(pendingLabelsRef.current);
                                }
                            }}
                            className="absolute left-2 right-2 top-0 bottom-0 bg-transparent text-xs placeholder-white/30 focus:outline-none"
                            style={{
                                color: '#ffffff',
                                fontWeight: 'bold',
                                textShadow: '0 1px 2px black',
                                // Only allow pointer interaction when editing via pencil or for new empty labels
                                pointerEvents: (editingInputId === l.id || (isSelected && l.text === '')) ? 'auto' : 'none'
                            }}
                            placeholder="Label..."
                            onMouseDown={(e) => {
                                if (e.button === 1) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onLabelsCommit(labels.filter(lb => lb.id !== l.id));
                                    if (isSelected) onSelectLabel(null);
                                    return;
                                }
                                e.stopPropagation();
                            }}
                            autoFocus={isSelected && l.text === ""}
                        />
                    ) : null}

                    {/* Pencil icon — appears on hover, click to focus text input */}
                    {isHovered && (
                      width > 60 ? (
                        // Render inside the label
                        <button
                          className="absolute top-0 bottom-0 right-5 flex items-center justify-center z-20 opacity-70 hover:opacity-100 transition-opacity"
                          onMouseEnter={() => handleLabelMouseEnter(l.id)}
                          onMouseLeave={handleLabelMouseLeave}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingInputId(l.id);
                            setPencilClickedId(l.id);
                          }}
                          title="Edit label text"
                        >
                          <Pencil size={10} className="text-white drop-shadow" />
                        </button>
                      ) : (
                        // Render outside to the right (floats above adjacent labels)
                        <button
                          className="absolute flex items-center justify-center bg-slate-800/90 rounded p-0.5 hover:bg-slate-700 transition-colors"
                          style={{ left: `${Math.max(2, width) + 2}px`, top: '4px', zIndex: 50 }}
                          onMouseEnter={() => handleLabelMouseEnter(l.id)}
                          onMouseLeave={handleLabelMouseLeave}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingInputId(l.id);
                            setPencilClickedId(l.id);
                          }}
                          title="Edit label text"
                        >
                          <Pencil size={10} className="text-white" />
                        </button>
                      )
                    )}

                    {/* Delete button */}
                    <button
                        className={`absolute -top-3 -right-3 ${isHovered ? 'flex' : 'hidden'} bg-red-500 rounded-full p-0.5 z-30`}
                        onMouseEnter={() => handleLabelMouseEnter(l.id)}
                        onMouseLeave={handleLabelMouseLeave}
                        onClick={(e) => {
                            e.stopPropagation();
                            onLabelsCommit(labels.filter(lb => lb.id !== l.id));
                            if (isSelected) onSelectLabel(null);
                            if (boundAnnotationId === l.id) {
                              setBoundAnnotationId(null);
                              onSelectionChange(null);
                            }
                        }}
                    >
                        <X size={10} className="text-white" />
                    </button>
                 </div>
             );
         })}

         {/* Creating annotation overlay (label mode) */}
         {renderCreatingOverlay()}

         {/* Selection region handles */}
         {renderSelectionHandles()}
      </div>

      {/* Layer 3: overlay canvas — axis, playhead, ident, selection darkening.
          z-30 keeps it above label HTML divs (z-10/20) and below nav buttons (z-50). */}
      <canvas
        ref={overlayCanvasRef}
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{ zIndex: 30 }}
      />

      {/* Next/Previous Annotation — sits left of the settings button (settings is at right-4) */}
      <div className="absolute top-1 right-14 z-50 flex flex-col items-center gap-0.5 pointer-events-auto">
        <span className="text-[9px] text-slate-400 font-medium tracking-wide whitespace-nowrap">Next/Prev Annotation</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); goToPrevAnnotation(); }}
            disabled={!canGoPrev}
            className={`flex items-center justify-center w-6 h-6 bg-black/60 rounded transition-colors ${
              canGoPrev
                ? 'hover:bg-black/80 text-white/70 hover:text-white cursor-pointer'
                : 'text-white/20 cursor-default'
            }`}
            title="Previous annotation (;)"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goToNextAnnotation(); }}
            disabled={!canGoNext}
            className={`flex items-center justify-center w-6 h-6 bg-black/60 rounded transition-colors ${
              canGoNext
                ? 'hover:bg-black/80 text-white/70 hover:text-white cursor-pointer'
                : 'text-white/20 cursor-default'
            }`}
            title="Next annotation (')"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default Spectrogram;
