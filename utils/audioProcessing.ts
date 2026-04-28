import { MAGMA_STOPS } from '../constants';
import { FrequencyScale } from '../types';

// Precompute color map (LUT) for performance — mirrors interpolateMagmaHex from constants.ts
// but returns raw RGB integers to avoid hex-string allocation in the hot render loop.
const COLOR_MAP = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const val = i / 255;
  let lower = MAGMA_STOPS[0];
  let upper = MAGMA_STOPS[MAGMA_STOPS.length - 1];
  for (let s = 0; s < MAGMA_STOPS.length - 1; s++) {
    if (val >= MAGMA_STOPS[s].pos && val <= MAGMA_STOPS[s + 1].pos) {
      lower = MAGMA_STOPS[s];
      upper = MAGMA_STOPS[s + 1];
      break;
    }
  }
  const range = upper.pos - lower.pos;
  const localT = range === 0 ? 0 : (val - lower.pos) / range;
  COLOR_MAP[i * 3]     = Math.round(lower.r + localT * (upper.r - lower.r));
  COLOR_MAP[i * 3 + 1] = Math.round(lower.g + localT * (upper.g - lower.g));
  COLOR_MAP[i * 3 + 2] = Math.round(lower.b + localT * (upper.b - lower.b));
}

// Module-scope scratch buffer for drawSpectrogramChunk — grown as needed, never shrunk.
// drawSpectrogramChunk is always called from the React rendering path (single-threaded),
// so this is safe to reuse across calls.
let _scratchPixels: Uint8ClampedArray = new Uint8ClampedArray(0);

// Module-level cache for the frequency bin map. Key encodes the 5 parameters that
// determine the mapping so we recompute only when they change.
const _binMapCache = new Map<string, Int32Array>();

// Mel Scale helpers
const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const fromMel = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);

// NOTE TO FUTURE READERS / CODE AUDITORS:
// This function does NOT decide which STFT column lands on which pixel.
// It receives `specData` as a **pre-composited viewport buffer** built by
// `Spectrogram.tsx` where there is already exactly one data column per
// canvas pixel (`specWidth === canvasWidth`). The column→pixel alignment
// lives in `Spectrogram.tsx` (see the `viewportData` loop around the
// `colStart`/`colEnd` computation). Here we only do per-pixel work:
// frequency-axis mapping (linear/log/mel), contrast/brightness, and
// colormap lookup. The `exactCol` formula below simplifies to `x` by
// construction — do not "fix" it without first reading the compositing
// loop in Spectrogram.tsx.
export const drawSpectrogramChunk = (
  ctx: CanvasRenderingContext2D,
  specData: Uint8Array,
  specWidth: number, // Total columns in data (== canvasWidth in current pipeline)
  specHeight: number, // Total bins
  startTime: number, // Time at x=0
  timePerPixel: number, // Duration per pixel
  totalDuration: number,
  canvasWidth: number,
  canvasHeight: number,
  brightness: number,
  contrast: number,
  minFreq: number,
  maxFreq: number,
  sampleRate: number,
  frequencyScale: FrequencyScale
) => {
  const needed = canvasWidth * canvasHeight * 4;
  if (_scratchPixels.length < needed) {
    _scratchPixels = new Uint8ClampedArray(needed);
  }
  // ImageData requires the array length to equal w*h*4 exactly, so take a subarray view.
  const data = _scratchPixels.length === needed
    ? _scratchPixels
    : _scratchPixels.subarray(0, needed);
  const imgData = new ImageData(data, canvasWidth, canvasHeight);

  // Pre-fill with the spectrogram background color (#0f172a = r:15 g:23 b:42)
  // so missing chunks and zero-value areas show navy rather than transparent/colormap-dark.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 15; data[i + 1] = 23; data[i + 2] = 42; data[i + 3] = 255;
  }

  // Pre-calculate Pixel Y -> Frequency Bin Index map.
  // Cached by the 5 parameters that determine the mapping; recomputed only on change.
  const binMapKey = `${canvasHeight}|${minFreq}|${maxFreq}|${sampleRate}|${frequencyScale}|${specHeight}`;
  let binMap = _binMapCache.get(binMapKey);
  if (!binMap) {
    binMap = new Int32Array(canvasHeight);
    const nyquist = sampleRate / 2;
    const safeMinFreq = Math.max(minFreq, 1); // Avoid log(0) issues

    for (let y = 0; y < canvasHeight; y++) {
        // y=0 is TOP of canvas (Max Freq)
        // y=height is BOTTOM of canvas (Min Freq)
        const normY = 1 - (y / canvasHeight);

        let targetFreq = 0;

        if (frequencyScale === 'linear') {
            targetFreq = minFreq + (normY * (maxFreq - minFreq));
        } else if (frequencyScale === 'log') {
            // f = min * (max/min)^normY
            targetFreq = safeMinFreq * Math.pow(maxFreq / safeMinFreq, normY);
        } else if (frequencyScale === 'mel') {
            const minM = toMel(minFreq);
            const maxM = toMel(maxFreq);
            const targetM = minM + (normY * (maxM - minM));
            targetFreq = fromMel(targetM);
        }

        const binIndex = Math.floor((targetFreq / nyquist) * specHeight);
        binMap[y] = Math.max(0, Math.min(binIndex, specHeight - 1));
    }
    _binMapCache.set(binMapKey, binMap);
  }

  for (let x = 0; x < canvasWidth; x++) {
    // Determine the exact time for this pixel
    const t = startTime + (x * timePerPixel);
    
    // Map time to column index relative to the data's start time
    const exactCol = ((t - startTime) / (canvasWidth * timePerPixel)) * specWidth;
    
    // Bounds check
    if (exactCol >= 0 && exactCol < specWidth) {
      const col = Math.floor(exactCol);

      for (let y = 0; y < canvasHeight; y++) {
        // Use pre-computed bin map for Y scaling
        const actualBin = binMap[y];
        
        // Map actualBin to array index (High->Low storage)
        const dataIndex = (specHeight - 1) - actualBin;
        
        // Direct access, no interpolation
        const rawIntensity = specData[col * specHeight + dataIndex];
        
        // Apply Contrast and Brightness
        // Normalize 0-255 to 0-1
        let nVal = rawIntensity / 255.0;
        
        // Simple contrast stretch around 0.5 center
        nVal = (nVal - 0.5) * contrast + 0.5;
        
        // Clamp 0-1
        if (nVal < 0) nVal = 0;
        if (nVal > 1) nVal = 1;

        // Apply brightness and convert back
        let val = nVal * 255 * brightness;
        
        // Clamp for color map
        if (val > 255) val = 255;
        if (val < 0) val = 0; // Should be covered, but safe check
        
        const colorIdx = Math.floor(val) * 3;

        const pixelIdx = (y * canvasWidth + x) * 4;
        data[pixelIdx] = COLOR_MAP[colorIdx];     // R
        data[pixelIdx + 1] = COLOR_MAP[colorIdx + 1]; // G
        data[pixelIdx + 2] = COLOR_MAP[colorIdx + 2]; // B
        data[pixelIdx + 3] = 255; // Alpha
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
};