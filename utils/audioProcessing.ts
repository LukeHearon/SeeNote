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

// Module-level cache for the frequency bin map.
// Key encodes the parameters that determine the mapping; recomputed only on change.
// Each entry stores Float32Array with 3 values per canvas row: [dataIndex0, dataIndex1, weight].
// dataIndex0/1 are the pre-reversed storage indices (col*specHeight + dataIndexN gives the cell).
// weight interpolates linearly between the two bins: value = (1-w)*v0 + w*v1.
const _binMapCache = new Map<string, Float32Array>();

// Mel Scale helpers
export const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
export const fromMel = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);

// Frequency ↔ Y-coordinate helpers.
// Convention: y=0 is TOP (maxFreq), y=canvasHeight is BOTTOM (minFreq).
// For 'log' scale, minFreq is clamped to 1 to avoid log(0).
export const yToFreq = (
  y: number,
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale
): number => {
  const normY = 1 - (y / canvasHeight);
  if (scale === 'linear') {
    return minFreq + (normY * (maxFreq - minFreq));
  } else if (scale === 'log') {
    const safeMinFreq = Math.max(minFreq, 1);
    return safeMinFreq * Math.pow(maxFreq / safeMinFreq, normY);
  } else {
    const minM = toMel(minFreq);
    const maxM = toMel(maxFreq);
    const targetM = minM + (normY * (maxM - minM));
    return fromMel(targetM);
  }
};

export const freqToY = (
  freq: number,
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale
): number => {
  let normY = 0;
  if (scale === 'linear') {
    normY = (freq - minFreq) / (maxFreq - minFreq);
  } else if (scale === 'log') {
    const safeMinFreq = Math.max(minFreq, 1);
    normY = Math.log(freq / safeMinFreq) / Math.log(maxFreq / safeMinFreq);
  } else {
    const minM = toMel(minFreq);
    const maxM = toMel(maxFreq);
    normY = (toMel(freq) - minM) / (maxM - minM);
  }
  return canvasHeight * (1 - normY);
};

// NOTE TO FUTURE READERS / CODE AUDITORS:
// This function does NOT decide which STFT column lands on which pixel.
// It is invoked by the offscreen-canvas builder in `Spectrogram.tsx`,
// which has already built a column-resolution viewport buffer where
// `specWidth === canvasWidth` (one data column per offscreen-canvas
// pixel). Time-axis resampling onto the visible canvas happens later
// via `ctx.drawImage` with bilinear filtering. Here we only do per-
// pixel work: frequency-axis mapping (linear/log/mel) and colormap
// lookup. `col === x` by construction — do not reintroduce a time-axis
// remap without first reading the offscreen pipeline in Spectrogram.tsx.
export const drawSpectrogramChunk = (
  ctx: CanvasRenderingContext2D,
  specData: Uint16Array,
  specWidth: number, // Total columns in data (== canvasWidth in current pipeline)
  specHeight: number, // Total bins
  canvasWidth: number,
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  sampleRate: number,
  frequencyScale: FrequencyScale,
  displayFloor: number,  // dBFS lower display bound
  displayCeil: number,   // dBFS upper display bound
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

  // Pre-calculate Pixel Y -> Frequency Bin interpolation map.
  // Cached by the parameters that determine the mapping; recomputed only on change.
  // Stores 3 floats per row: [dataIndex0, dataIndex1, weight].
  // The Rust layout stores index 0 = highest freq, so dataIndex = (specHeight-1) - binIndex.
  const binMapKey = `${canvasHeight}|${minFreq}|${maxFreq}|${sampleRate}|${frequencyScale}|${specHeight}`;
  let binMap = _binMapCache.get(binMapKey);
  if (!binMap) {
    binMap = new Float32Array(canvasHeight * 3);
    const nyquist = sampleRate / 2;

    for (let y = 0; y < canvasHeight; y++) {
      const targetFreq = yToFreq(y, canvasHeight, minFreq, maxFreq, frequencyScale);
      const binFrac = (targetFreq / nyquist) * specHeight;
      const i0 = Math.max(0, Math.min(Math.floor(binFrac), specHeight - 1));
      const i1 = Math.min(i0 + 1, specHeight - 1);
      const w = binFrac - Math.floor(binFrac);
      // Pre-reverse: storage index = (specHeight - 1) - binIndex
      binMap[y * 3]     = (specHeight - 1) - i0;  // dataIndex0
      binMap[y * 3 + 1] = (specHeight - 1) - i1;  // dataIndex1
      binMap[y * 3 + 2] = w;
    }
    _binMapCache.set(binMapKey, binMap);
  }

  const dbRange = displayCeil - displayFloor;

  for (let x = 0; x < canvasWidth; x++) {
    const colOffset = x * specHeight;

    for (let y = 0; y < canvasHeight; y++) {
      const mapBase = y * 3;
      const dIdx0 = binMap[mapBase];
      const dIdx1 = binMap[mapBase + 1];
      const w = binMap[mapBase + 2];

      // Linearly interpolate between adjacent bins to eliminate banding artifacts
      // (especially visible in mel scale where low-freq bins are stretched over many rows).
      const rawU16 = (1 - w) * specData[colOffset + dIdx0] + w * specData[colOffset + dIdx1];

      // Decode u16 → dBFS: 0 → -140 dBFS, 65535 → 0 dBFS
      const dB = (rawU16 / 65535) * 140 - 140;

      // Map dB linearly into [0,1] using the user-controlled display window
      let nVal = (dB - displayFloor) / dbRange;
      if (nVal < 0) nVal = 0;
      if (nVal > 1) nVal = 1;

      const colorIdx = Math.floor(nVal * 255) * 3;

      const pixelIdx = (y * canvasWidth + x) * 4;
      data[pixelIdx]     = COLOR_MAP[colorIdx];
      data[pixelIdx + 1] = COLOR_MAP[colorIdx + 1];
      data[pixelIdx + 2] = COLOR_MAP[colorIdx + 2];
      data[pixelIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
};
