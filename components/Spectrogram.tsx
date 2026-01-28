import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Label, SpectrogramSettings, LabelConfig } from '../types';
import { drawSpectrogramChunk } from '../utils/audioProcessing';
import { formatTime, calculateLabelLayers } from '../utils/helpers';
import { X } from 'lucide-react';

interface SpectrogramProps {
  audioBuffer: AudioBuffer | null;
  specData: { data: Uint8Array; width: number; height: number; sampleRate: number } | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isProcessing: boolean;
  settings: SpectrogramSettings;
  labels: Label[];
  selectedLabelId: string | null;
  activeLabelConfig: LabelConfig;
  labelConfigs: LabelConfig[]; // Added to check for name collisions
  onSeek: (time: number) => void;
  onLabelsChange: (labels: Label[]) => void;
  onSelectLabel: (id: string | null) => void;
  onZoomChange: (newWindowSize: number) => void; 
}

// Helpers for scale mapping (duplicated locally for Y-axis calculation)
const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const fromMel = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);

const Spectrogram: React.FC<SpectrogramProps> = ({
  specData,
  currentTime,
  duration,
  isPlaying,
  isProcessing,
  settings,
  labels,
  selectedLabelId,
  activeLabelConfig,
  labelConfigs,
  onSeek,
  onLabelsChange,
  onSelectLabel,
  onZoomChange
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  
  // Internal scroll state (in pixels)
  const [scrollLeft, setScrollLeft] = useState(0); 
  const [dragStart, setDragStart] = useState<{ x: number; scroll: number } | null>(null);

  // Interaction State (Labels)
  const [creatingLabel, setCreatingLabel] = useState<{ start: number; current: number } | null>(null);
  const [resizingLabel, setResizingLabel] = useState<{ id: string; side: 'start' | 'end'; originalTime: number } | null>(null);
  const [draggedLabel, setDraggedLabel] = useState<{ id: string; startOffset: number } | null>(null);

  const requestRef = useRef<number | null>(null);
  
  // Calculate pixelsPerSecond based on settings.windowSize
  const pixelsPerSecond = useMemo(() => {
     if (!containerRef.current) return 100;
     return containerRef.current.clientWidth / settings.windowSize;
  }, [settings.windowSize, containerRef.current?.clientWidth]);

  // Sync scroll with playback
  useEffect(() => {
      if (isPlaying && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          const playheadPos = currentTime * pixelsPerSecond;
          
          const targetScroll = playheadPos - (containerWidth / 2);
          
          if (targetScroll > 0) {
              setScrollLeft(targetScroll);
          } else {
              setScrollLeft(0);
          }
      }
  }, [isPlaying, currentTime, pixelsPerSecond]);

  // Canvas Drawing Loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return; // Only need canvas presence
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Calculations for smooth scrolling
    const startTime = scrollLeft / pixelsPerSecond;
    const timePerPixel = 1 / pixelsPerSecond;
    const endTime = startTime + (width * timePerPixel);

    // 1. Draw Spectrogram Data if Available
    if (specData) {
        drawSpectrogramChunk(
          ctx,
          specData.data,
          specData.width,
          specData.height,
          startTime,
          timePerPixel,
          duration,
          width,
          height,
          settings.intensity,
          settings.contrast,
          settings.minFreq,
          settings.maxFreq,
          specData.sampleRate,
          settings.frequencyScale
        );
    } else {
        // Draw Placeholder Grid if no data (but duration exists)
        if (duration > 0 && !isProcessing) {
            ctx.fillStyle = '#0f172a'; // Match background
            ctx.fillRect(0, 0, width, height);
            
            // Draw subtle grid lines
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for(let i=0; i<width; i+=50) {
                ctx.moveTo(i, 0); ctx.lineTo(i, height);
            }
            ctx.stroke();

            // Center Text
            ctx.fillStyle = '#334155';
            ctx.font = 'bold 24px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("Spectrogram Unavailable", width/2, height/2);
            ctx.font = '14px sans-serif';
            ctx.fillText("Audio decoding failed for this format", width/2, height/2 + 25);
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
    // Draw a semi-transparent background for readability
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
             // Tick mark
             ctx.beginPath();
             ctx.moveTo(45, y);
             ctx.lineTo(50, y);
             ctx.strokeStyle = 'rgba(255,255,255,0.5)';
             ctx.stroke();

             // Label (Format: 1k, 500, etc)
             let label = freq.toString();
             if (freq >= 1000) {
                 label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
             }
             ctx.fillText(label, 42, y);
         }
    };

    if (settings.frequencyScale === 'log') {
        // Log Scale Ticks: Powers of 10 and 1, 2, 5 multiples
        let mag = 10;
        while (mag < settings.maxFreq) {
            [1, 2, 5].forEach(mult => {
                const freq = mag * mult;
                if (freq >= settings.minFreq && freq <= settings.maxFreq) {
                    renderTick(freq);
                }
            });
            mag *= 10;
        }
    } else {
        // Linear & Mel can use evenly spaced steps (conceptually)
        // For Mel, we might want to space evenly in Mel domain, but visualizing Hz ticks is usually preferred.
        // Let's stick to standard linear Hz ticks mapped correctly.
        const range = settings.maxFreq - settings.minFreq;
        if (range > 0) {
            // Calculate nice step
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
    if (timeRange < 2) timeStep = 0.25;
    else if (timeRange < 10) timeStep = 1;
    else if (timeRange < 30) timeStep = 2;
    else timeStep = 5;

    ctx.lineWidth = 3;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const firstTimeTick = Math.floor(startTime / timeStep) * timeStep;
    
    for(let s = firstTimeTick; s <= endTime; s += timeStep) {
        if (s < 0) continue;
        const x = (s * pixelsPerSecond) - scrollLeft;
        
        // Don't draw time ticks over the frequency axis
        if (x >= 50 && x <= width + 50) {
            // Tick mark
            ctx.beginPath();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.moveTo(x, height);
            ctx.lineTo(x, height - 8);
            ctx.stroke();

            // Text
            const timeStr = timeStep < 1 ? s.toFixed(2) : formatTime(s);
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 3;
            ctx.strokeText(timeStr, x, height - 10);
            
            ctx.fillStyle = 'white';
            ctx.fillText(timeStr, x, height - 10);
        }
    }

  }, [specData, scrollLeft, pixelsPerSecond, duration, settings.intensity, settings.contrast, currentTime, settings.minFreq, settings.maxFreq, settings.frequencyScale, isProcessing]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(draw);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [draw]);

  // Handle Resize
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      if (canvasRef.current && entries[0]) {
        const { width, height } = entries[0].contentRect;
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        draw();
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [draw]);

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
        onSelectLabel(null);
        
        const t = getPointerTime(e);
        setCreatingLabel({ start: t, current: t });
        onSeek(t); 
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragStart) {
      const delta = dragStart.x - e.clientX;
      setScrollLeft(Math.max(0, dragStart.scroll + delta));
      return;
    }

    const t = getPointerTime(e);

    if (creatingLabel) {
      setCreatingLabel({ ...creatingLabel, current: t });
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
      onLabelsChange(updated);
      return;
    }

    if (draggedLabel) {
       const updated = labels.map(l => {
           if (l.id === draggedLabel.id) {
               const duration = l.end - l.start;
               const newStart = Math.max(0, t - draggedLabel.startOffset);
               return { ...l, start: newStart, end: newStart + duration };
           }
           return l;
       });
       onLabelsChange(updated);
       return;
    }
  };

  const handleMouseUp = () => {
    if (dragStart) setDragStart(null);

    if (creatingLabel) {
      const start = Math.min(creatingLabel.start, creatingLabel.current);
      const end = Math.max(creatingLabel.start, creatingLabel.current);
      
      if (end - start > 0.05) { 
        const id = Math.random().toString(36).substr(2, 9);
        const isActiveDefault = activeLabelConfig.key === "0";
        
        const newLabel: Label = {
            id,
            configId: activeLabelConfig.key,
            start,
            end,
            text: isActiveDefault ? "" : activeLabelConfig.text,
            color: activeLabelConfig.color
        };
        onLabelsChange([...labels, newLabel]);
        onSelectLabel(id); 
      }
      setCreatingLabel(null);
    }

    setResizingLabel(null);
    setDraggedLabel(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
      // Zoom if Ctrl (Windows/Linux) or Meta (Mac) is held
      if(e.ctrlKey || e.metaKey) {
        e.preventDefault();
        
        if (!containerRef.current) return;
        
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

        // Calculate time currently under the mouse cursor
        const timeAtMouse = (scrollLeft + mouseX) / pixelsPerSecond;

        const zoomFactor = 1.1;
        const direction = e.deltaY > 0 ? 1 : -1; 
        
        let newWindowSize = settings.windowSize * (direction > 0 ? zoomFactor : 1 / zoomFactor);
        newWindowSize = Math.max(1, Math.min(newWindowSize, 60, duration || 60));
        
        // Calculate new pixels per second based on new window size
        const containerWidth = containerRef.current.clientWidth;
        const newPixelsPerSecond = containerWidth / newWindowSize;

        // We want: (newScrollLeft + mouseX) / newPixelsPerSecond = timeAtMouse
        // newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX
        let newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX;

        // Clamp
        const maxScroll = Math.max(0, (duration * newPixelsPerSecond) - containerWidth);
        newScrollLeft = Math.max(0, Math.min(newScrollLeft, maxScroll));

        // Update Scroll State
        setScrollLeft(newScrollLeft);

        // Propagate window size change
        onZoomChange(newWindowSize);
      } else {
          // Pan
          const panAmount = e.deltaY + e.deltaX;
          const maxScroll = Math.max(0, (duration * pixelsPerSecond) - (containerRef.current?.clientWidth || 0));
          setScrollLeft(prev => Math.max(0, Math.min(prev + panAmount, maxScroll)));
      }
  };

  const layeredLabels = useMemo(() => calculateLabelLayers(labels), [labels]);
  
  const renderCreatingOverlay = () => {
    if (!creatingLabel) return null;
    const s = Math.min(creatingLabel.start, creatingLabel.current);
    const e = Math.max(creatingLabel.start, creatingLabel.current);
    const left = (s * pixelsPerSecond) - scrollLeft;
    const width = ((e - s) * pixelsPerSecond);
    
    return (
        <div 
            className="absolute top-0 bottom-0 bg-white/20 border-l border-r border-white/50 pointer-events-none"
            style={{ left: `${left}px`, width: `${width}px` }}
        >
            <span className="absolute -top-6 left-0 text-xs bg-black/80 px-1 rounded text-white">{formatTime(s)}</span>
            <span className="absolute -top-6 right-0 text-xs bg-black/80 px-1 rounded text-white">{formatTime(e)}</span>
        </div>
    );
  };

  return (
    <div 
        ref={containerRef}
        className="relative w-full h-full bg-slate-900 overflow-hidden cursor-crosshair select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
      
      <div ref={interactionRef} className="absolute top-0 left-0 w-full h-full">
         {layeredLabels.map((l) => {
             const left = (l.start * pixelsPerSecond) - scrollLeft;
             const width = (l.end - l.start) * pixelsPerSecond;
             const isSelected = selectedLabelId === l.id;
             
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

             return (
                 <div
                    key={l.id}
                    className="label-item absolute group rounded transition-colors duration-200"
                    style={{ 
                        left: `${left}px`, 
                        width: `${Math.max(2, width)}px`, 
                        top: `${top}px`,
                        height: '30px',
                        border: `1px solid ${styleVars.borderColor}`,
                        backgroundColor: styleVars.bgColor,
                        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                        zIndex: isSelected ? 20 : 10
                    }}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        // Middle Click Delete (Button 1)
                        if (e.button === 1) {
                            e.preventDefault();
                            onLabelsChange(labels.filter(lb => lb.id !== l.id));
                            if(isSelected) onSelectLabel(null);
                            return;
                        }
                        onSelectLabel(l.id);
                        setDraggedLabel({ id: l.id, startOffset: getPointerTime(e) - l.start });
                    }}
                 >
                    <div 
                        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onSelectLabel(l.id);
                            setResizingLabel({ id: l.id, side: 'start', originalTime: l.start });
                        }}
                    >
                        {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
                    </div>
                    <div 
                        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onSelectLabel(l.id);
                            setResizingLabel({ id: l.id, side: 'end', originalTime: l.end });
                        }}
                    >
                         {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
                    </div>

                    {width > 30 ? (
                        <input 
                            type="text"
                            value={l.text}
                            onChange={(e) => {
                                const newText = e.target.value;
                                const newLabels = labels.map(lb => {
                                    if (lb.id === l.id) {
                                        // Check for collisions with predefined labels (case insensitive)
                                        const matchingConfig = labelConfigs.find(c => c.text.toLowerCase() === newText.toLowerCase() && c.key !== "0");
                                        
                                        if (matchingConfig) {
                                             return { ...lb, text: matchingConfig.text, configId: matchingConfig.key, color: matchingConfig.color };
                                        }

                                        // If modifying a predefined label that doesn't match anymore, convert to Custom (White, Config 0)
                                        if (lb.configId !== "0" && lb.color !== "#ffffff" && lb.text !== newText) {
                                            return { ...lb, text: newText, configId: "0", color: "#ffffff" };
                                        }
                                        return { ...lb, text: newText };
                                    } 
                                    return lb;
                                });
                                onLabelsChange(newLabels);
                            }}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') {
                                    onSelectLabel(null);
                                    (e.target as HTMLInputElement).blur();
                                }
                                if (e.key === 'Escape') {
                                    onSelectLabel(null);
                                    (e.target as HTMLInputElement).blur();
                                }
                            }}
                            onBlur={(e) => {
                                // If label is empty on blur (and it's custom), delete it
                                if (l.text.trim() === "") {
                                    onLabelsChange(labels.filter(lb => lb.id !== l.id));
                                    onSelectLabel(null);
                                }
                            }}
                            className="absolute left-2 right-2 top-0 bottom-0 bg-transparent text-xs placeholder-white/30 focus:outline-none"
                            style={{ 
                                color: '#ffffff', 
                                fontWeight: 'bold',
                                textShadow: '0 1px 2px black' 
                            }}
                            placeholder="Label..."
                            onMouseDown={(e) => {
                                if (e.button === 1) { // Middle click to delete
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onLabelsChange(labels.filter(lb => lb.id !== l.id));
                                    if(isSelected) onSelectLabel(null);
                                    return;
                                }
                                e.stopPropagation();
                            }} 
                            autoFocus={isSelected && l.text === ""}
                        />
                    ) : null}

                    <button 
                        className="absolute -top-3 -right-3 hidden group-hover:flex bg-red-500 rounded-full p-0.5 z-30"
                        onClick={(e) => {
                            e.stopPropagation();
                            onLabelsChange(labels.filter(lb => lb.id !== l.id));
                            if(isSelected) onSelectLabel(null);
                        }}
                    >
                        <X size={10} className="text-white" />
                    </button>
                 </div>
             );
         })}
         
         {renderCreatingOverlay()}
      </div>
    </div>
  );
};

export default Spectrogram;