import { interpolateMagmaHex } from '../constants';
import { FrequencyScale } from '../types';
import { yToFreq } from './audioProcessing';

// Colormap as packed little-endian RGBA words, built from the one colormap
// definition in constants.ts (interpolateMagmaHex) rather than a second copy of
// the stop interpolation. 256 steps; the hex round-trip is exact because the
// hex is built from the same rounded channel values.
const MAGMA_RGB = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const hex = interpolateMagmaHex(i / 255);
  MAGMA_RGB[i] =
    parseInt(hex.slice(1, 3), 16) |
    (parseInt(hex.slice(3, 5), 16) << 8) |
    (parseInt(hex.slice(5, 7), 16) << 16);
}

// Opaque pixel for a colormap entry / the unbuilt-column pixel (#0f172a at zero
// alpha), as the Uint32 view of RGBA bytes. Pixels are written through a Uint32Array
// over the ImageData buffer, which lays bytes out in platform order — little-endian
// on every platform this app targets (checked once below; the byte-wise fallback
// keeps a big-endian host correct rather than fast).
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const packRgba = (r: number, g: number, b: number, a: number): number =>
  LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
const UNBUILT_PIXEL = packRgba(15, 23, 42, 0);

// u16 sample → packed pixel, for one (displayFloor, displayCeil) window. Replaces
// the per-pixel dB decode, clamp and colormap lookup with one table read; rebuilt
// (65536 entries, ~1ms) only when the level range changes.
let _lut = new Uint32Array(65536);
let _lutFloor = NaN;
let _lutCeil = NaN;
const levelLut = (displayFloor: number, displayCeil: number): Uint32Array => {
  if (displayFloor === _lutFloor && displayCeil === _lutCeil) return _lut;
  const dbRange = displayCeil - displayFloor;
  for (let u = 0; u < 65536; u++) {
    // Decode u16 → dBFS: 0 → -140 dBFS, 65535 → 0 dBFS
    const dB = (u / 65535) * 140 - 140;
    // Map dB linearly into [0,1] using the user-controlled display window
    let nVal = (dB - displayFloor) / dbRange;
    if (nVal < 0) nVal = 0;
    if (nVal > 1) nVal = 1;
    const c = MAGMA_RGB[Math.floor(nVal * 255)];
    _lut[u] = packRgba(c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, 255);
  }
  _lutFloor = displayFloor;
  _lutCeil = displayCeil;
  return _lut;
};

// Module-scope pixel buffer for drawSpectrogramChunk — grown as needed, never
// shrunk — with its Uint32 view and the ImageData last wrapped around it.
// drawSpectrogramChunk is always called from the React rendering path
// (single-threaded), so this is safe to reuse across calls.
let _scratchPixels: Uint8ClampedArray = new Uint8ClampedArray(0);
let _scratch32: Uint32Array = new Uint32Array(0);
let _image: ImageData | null = null;

const imageFor = (width: number, height: number): { image: ImageData; px: Uint32Array } => {
  const needed = width * height;
  if (_scratch32.length < needed) {
    _scratchPixels = new Uint8ClampedArray(needed * 4);
    _scratch32 = new Uint32Array(_scratchPixels.buffer);
    _image = null;
  }
  // The incremental path calls with a handful of recurring widths, so a
  // same-shape ImageData is usually still the one to hand back.
  if (!_image || _image.width !== width || _image.height !== height) {
    // ImageData requires the array length to equal w*h*4 exactly, so take a subarray view.
    _image = new ImageData(_scratchPixels.subarray(0, needed * 4), width, height);
  }
  return { image: _image, px: _scratch32 };
};

// ── Time-axis column resampling ─────────────────────────────────────────────
// One offscreen column covers the window [pos, posEnd) of a chunk's column
// grid, expressed in fractional column coordinates (column centers sit at
// integer coordinates). Fill dst[dstOffset .. dstOffset+bins) from that window:
//
//   - ≥2 centers in the window → equal-weight area average. A transient's
//     energy lands in exactly one output column with a value that does not
//     depend on sub-column phase — nearest-sampling instead made transients
//     appear and disappear with scroll position.
//   - exactly 1 center → plain copy of that column.
//   - 0 centers (chunk coarser than the pixel grid, i.e. upsampling) → linear
//     interpolation at the window center, matching the smoothness of the
//     canvas-bilinear upsample this replaces.
//
// Callers anchor windows to absolute column indices, so the output is a pure
// function of file time — the invariance that keeps the scrolling spectrogram
// image rock-solid.
let _colAccum = new Float64Array(0);
export const sampleChunkColumnInto = (
  dst: Uint16Array,
  dstOffset: number,
  bins: number,
  data: Uint16Array,
  nFreqBins: number,
  nCols: number,
  pos: number,
  posEnd: number,
): void => {
  let c0 = Math.ceil(pos);
  let c1 = Math.ceil(posEnd);
  if (c0 < 0) c0 = 0;
  if (c1 > nCols) c1 = nCols;
  const span = c1 - c0;
  if (span >= 2) {
    // Cap the work for pathological windows (e.g. a much finer tier serving as
    // a temporary fallback while zoomed far out): average a strided subset.
    // The stride pattern starts at c0, an absolute index, so it's still
    // deterministic per output column.
    const stride = span > 32 ? Math.ceil(span / 32) : 1;
    if (_colAccum.length < bins) _colAccum = new Float64Array(bins);
    const acc = _colAccum;
    acc.fill(0, 0, bins);
    let n = 0;
    for (let c = c0; c < c1; c += stride) {
      const off = c * nFreqBins;
      for (let b = 0; b < bins; b++) acc[b] += data[off + b];
      n++;
    }
    const inv = 1 / n;
    for (let b = 0; b < bins; b++) dst[dstOffset + b] = acc[b] * inv + 0.5;
    return;
  }
  if (span === 1) {
    dst.set(data.subarray(c0 * nFreqBins, c0 * nFreqBins + bins), dstOffset);
    return;
  }
  // Upsampling: interpolate at the window center between its two neighbours.
  const pc = (pos + posEnd) / 2;
  let base = Math.floor(pc);
  let frac = pc - base;
  if (base < 0) { base = 0; frac = 0; }
  if (base >= nCols - 1) { base = nCols - 1; frac = 0; }
  const off = base * nFreqBins;
  if (frac === 0) {
    dst.set(data.subarray(off, off + bins), dstOffset);
    return;
  }
  const off2 = off + nFreqBins;
  for (let b = 0; b < bins; b++) {
    const a = data[off + b];
    dst[dstOffset + b] = a + (data[off2 + b] - a) * frac + 0.5;
  }
};

// Module-level cache for the frequency bin map.
// Key encodes the parameters that determine the mapping; recomputed only on change.
// Each entry stores Float32Array with 3 values per canvas row: [dataIndex0, dataIndex1, weight].
// dataIndex0/1 are the pre-reversed storage indices (col*specHeight + dataIndexN gives the cell).
// weight interpolates linearly between the two bins: value = (1-w)*v0 + w*v1.
const _binMapCache = new Map<string, Float32Array>();

// NOTE TO FUTURE READERS / CODE AUDITORS:
// This function does NOT decide which STFT column lands on which pixel.
// It is invoked by the offscreen-canvas builder in `useChunkRenderer.ts`,
// which has already resampled chunk data onto a one-column-per-physical-
// pixel buffer (via sampleChunkColumnInto above) where `specWidth ===
// canvasWidth`. The visible canvas then receives a 1:1 pixel-snapped
// blit — no further time-axis resampling anywhere. Here we only do per-
// pixel work: frequency-axis mapping (linear/log/mel) and colormap
// lookup. `col === x` by construction — do not reintroduce a time-axis
// remap without first reading the offscreen pipeline in useChunkRenderer.ts.
export const drawSpectrogramChunk = (
  ctx: CanvasRenderingContext2D,
  specData: Uint16Array,
  specHeight: number, // Total bins
  canvasWidth: number,
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  sampleRate: number,
  frequencyScale: FrequencyScale,
  displayFloor: number,  // dBFS lower display bound
  displayCeil: number,   // dBFS upper display bound
  colMask?: Uint8Array,  // optional per-column (length specWidth) build mask;
                         // columns with value 0 are rendered fully transparent
) => {
  const { image, px } = imageFor(canvasWidth, canvasHeight);

  // NOTE: there is deliberately no whole-buffer background pre-fill here. Every
  // call site passes specWidth === canvasWidth, so the column loop below writes
  // every pixel — colormap for built columns, the background colour at zero
  // alpha for the ones colMask flags unbuilt. A pre-fill pass was therefore pure
  // dead work: on a 2400x760 physical-pixel canvas it stored 7.3MB per call,
  // every frame, and not one byte survived. It measured at ~17% of all JS
  // execution (local/profile/FINDINGS.md).
  const lut = levelLut(displayFloor, displayCeil);

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

  for (let x = 0; x < canvasWidth; x++) {
    const colOffset = x * specHeight;

    // Unbuilt columns: the spectrogram background colour (#0f172a) at zero
    // alpha, so the build-progress sweep behind the canvas shows through and
    // they read identically to navy when no sweep is present (the container
    // background is #0f172a too). Written in full rather than as an alpha-only
    // stripe because the scratch buffer is reused across calls and still holds
    // the previous frame's colours. Skips the per-pixel colormap work.
    // specWidth === canvasWidth in this pipeline, so colMask is indexed by x.
    if (colMask && colMask[x] === 0) {
      for (let y = 0; y < canvasHeight; y++) px[y * canvasWidth + x] = UNBUILT_PIXEL;
      continue;
    }

    for (let y = 0; y < canvasHeight; y++) {
      const mapBase = y * 3;
      const w = binMap[mapBase + 2];

      // Linearly interpolate between adjacent bins to eliminate banding artifacts
      // (especially visible in mel scale where low-freq bins are stretched over many rows).
      const rawU16 = (1 - w) * specData[colOffset + binMap[mapBase]] + w * specData[colOffset + binMap[mapBase + 1]];

      px[y * canvasWidth + x] = lut[(rawU16 + 0.5) | 0];
    }
  }

  ctx.putImageData(image, 0, 0);
};
