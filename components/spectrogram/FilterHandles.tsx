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

  const yHigh = freqToY(bandPassFilter.high, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
  const yLow = freqToY(bandPassFilter.low, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);

  return (
    <>
      {yHigh >= 0 && yHigh <= canvasHeight && (
        <div
          className="absolute left-0 right-0 cursor-ns-resize"
          style={{ top: `${yHigh - 4}px`, height: '9px', zIndex: 15 }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onBeginResize('high');
          }}
        >
          <div className="absolute left-0 right-0" style={{ top: '4px', height: '1px', background: '#60a5fa' }} />
        </div>
      )}
      {yLow >= 0 && yLow <= canvasHeight && (
        <div
          className="absolute left-0 right-0 cursor-ns-resize"
          style={{ top: `${yLow - 4}px`, height: '9px', zIndex: 15 }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onBeginResize('low');
          }}
        >
          <div className="absolute left-0 right-0" style={{ top: '4px', height: '1px', background: '#60a5fa' }} />
        </div>
      )}
    </>
  );
};

export default FilterHandles;
