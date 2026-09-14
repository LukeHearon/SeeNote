import React from 'react';
import { BandPassFilter, SpectrogramSettings } from '../../types';
import { freqToY } from '../../utils/audioProcessing';

interface FilterHandlesProps {
  bandPassFilter: BandPassFilter | null;
  creatingFilter: { y0: number; y1: number } | null;
  settings: SpectrogramSettings;
  containerHeight: number;
  onBeginResize: (edge: 'low' | 'high') => void;
}

// Render horizontal cutoff handles for the band-pass filter. Render-only — the
// drag itself stays in Spectrogram.tsx; this calls back via onBeginResize.
const FilterHandles: React.FC<FilterHandlesProps> = ({
  bandPassFilter,
  creatingFilter,
  settings,
  containerHeight,
  onBeginResize,
}) => {
  if (!bandPassFilter || creatingFilter) return null;
  const canvasHeight = containerHeight;
  if (canvasHeight === 0) return null;

  const rawYHigh = freqToY(bandPassFilter.high, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
  const rawYLow = freqToY(bandPassFilter.low, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
  // A cutoff can sit outside the visible frequency window (e.g. view 200 Hz–4 kHz
  // while the filter passes 800 Hz–22 kHz). Pin the off-screen handle to the
  // nearest edge so it stays grabbable to drag back into range.
  const clampY = (y: number) => Math.max(0, Math.min(canvasHeight, y));
  const yHigh = clampY(rawYHigh);
  const yLow = clampY(rawYLow);

  const handle = (y: number, edge: 'low' | 'high', offScreen: boolean) => (
    <div
      className="absolute left-0 right-0 cursor-ns-resize"
      style={{ top: `${y - 4}px`, height: '9px', zIndex: 15 }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onBeginResize(edge);
      }}
    >
      <div
        className="absolute left-0 right-0"
        style={{ top: '4px', height: '1px', background: '#60a5fa', opacity: offScreen ? 0.5 : 1 }}
      />
    </div>
  );

  return (
    <>
      {handle(yHigh, 'high', rawYHigh < 0 || rawYHigh > canvasHeight)}
      {handle(yLow, 'low', rawYLow < 0 || rawYLow > canvasHeight)}
    </>
  );
};

export default FilterHandles;
