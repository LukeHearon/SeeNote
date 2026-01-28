import { MAGMA_STOPS } from '../constants';
import { FrequencyScale } from '../types';

// Helper to interpolate colors
const interpolateColor = (val: number) => {
  // val is 0 to 1
  let lower = MAGMA_STOPS[0];
  let upper = MAGMA_STOPS[MAGMA_STOPS.length - 1];

  for (let i = 0; i < MAGMA_STOPS.length - 1; i++) {
    if (val >= MAGMA_STOPS[i].pos && val <= MAGMA_STOPS[i + 1].pos) {
      lower = MAGMA_STOPS[i];
      upper = MAGMA_STOPS[i + 1];
      break;
    }
  }

  const range = upper.pos - lower.pos;
  const rangePct = (val - lower.pos) / range;
  const pctLower = 1 - rangePct;
  const pctUpper = rangePct;

  const r = Math.floor(lower.r * pctLower + upper.r * pctUpper);
  const g = Math.floor(lower.g * pctLower + upper.g * pctUpper);
  const b = Math.floor(lower.b * pctLower + upper.b * pctUpper);

  return [r, g, b];
};

// Precompute color map (LUT) for performance
const COLOR_MAP = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const [r, g, b] = interpolateColor(i / 255);
  COLOR_MAP[i * 3] = r;
  COLOR_MAP[i * 3 + 1] = g;
  COLOR_MAP[i * 3 + 2] = b;
}

/**
 * Computes the FFT data for the audio buffer.
 */
export const generateSpectrogramData = async (
  audioBuffer: AudioBuffer,
  fftSize: number = 1024,
  hopSize: number = 512 // Overlap
): Promise<{ data: Uint8Array; width: number; height: number; sampleRate: number }> => {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const length = channelData.length;

  const width = Math.floor((length - fftSize) / hopSize);
  const height = fftSize / 2; // Frequency bins

  // Create output buffer (Flat array: column by column)
  const outputData = new Uint8Array(width * height);

  // We perform a simplified STFT here using a Hanning window
  const window = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  }

  // Pre-calculate real/imag arrays to reuse
  // Precompute bit reversal table
  const reverseBits = (x: number, n: number) => {
    let result = 0;
    for (let i = 0; i < n; i++) {
      if ((x >> i) & 1) result |= (1 << (n - 1 - i));
    }
    return result;
  };
  
  const bits = Math.log2(fftSize);
  const rev = new Uint16Array(fftSize);
  for(let i=0; i<fftSize; i++) rev[i] = reverseBits(i, bits);

  // Precompute Sine/Cosine tables
  const sinTable = new Float32Array(fftSize / 2);
  const cosTable = new Float32Array(fftSize / 2);
  for(let i=0; i<fftSize/2; i++) {
    sinTable[i] = Math.sin(-2 * Math.PI * i / fftSize);
    cosTable[i] = Math.cos(-2 * Math.PI * i / fftSize);
  }

  // Iterative FFT implementation
  const performFFT = (input: Float32Array) => {
      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);
      
      for(let i=0; i<fftSize; i++) {
        real[rev[i]] = input[i] * window[i];
        imag[rev[i]] = 0;
      }

      for (let size = 2; size <= fftSize; size *= 2) {
        const halfSize = size / 2;
        const step = fftSize / size;
        for (let i = 0; i < fftSize; i += size) {
          for (let j = 0; j < halfSize; j++) {
            const k = j * step;
            const tReal = real[i + j + halfSize] * cosTable[k] - imag[i + j + halfSize] * sinTable[k];
            const tImag = real[i + j + halfSize] * sinTable[k] + imag[i + j + halfSize] * cosTable[k];
            
            real[i + j + halfSize] = real[i + j] - tReal;
            imag[i + j + halfSize] = imag[i + j] - tImag;
            real[i + j] += tReal;
            imag[i + j] += tImag;
          }
        }
      }
      return { real, imag };
  };

  // Main Processing Loop
  for (let col = 0; col < width; col++) {
    const startIdx = col * hopSize;
    // Extract chunk
    const chunk = channelData.subarray(startIdx, startIdx + fftSize);
    if (chunk.length < fftSize) break;

    // Run FFT
    const { real: r, imag: i } = performFFT(chunk as Float32Array); // Cast because subarray returns Float32Array

    // Compute Magnitude & Log Scale
    for (let bin = 0; bin < height; bin++) {
      const mag = Math.sqrt(r[bin] * r[bin] + i[bin] * i[bin]);
      // Logarithmic scaling for audio decibels visualization
      const val = 20 * Math.log10(mag + 1e-6); 
      // Normalize roughly (-100db to 0db range to 0-255)
      let intensity = (val + 60) * 4; 
      if (intensity < 0) intensity = 0;
      if (intensity > 255) intensity = 255;
      
      // Store in output buffer. 
      // We store visual intensity directly (0-255)
      outputData[col * height + (height - 1 - bin)] = intensity; 
    }

    // Optimization: Allow UI to breathe
    if (col % 1000 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { data: outputData, width, height, sampleRate };
};

// Mel Scale helpers
const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const fromMel = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);

export const drawSpectrogramChunk = (
  ctx: CanvasRenderingContext2D,
  specData: Uint8Array,
  specWidth: number, // Total columns in data
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
  const imgData = ctx.createImageData(canvasWidth, canvasHeight);
  const data = imgData.data;

  // Pre-calculate Pixel Y -> Frequency Bin Index map
  // This allows us to handle Linear, Log, and Mel scales efficiently in the pixel loop
  const binMap = new Int32Array(canvasHeight);
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

  for (let x = 0; x < canvasWidth; x++) {
    // Determine the exact time for this pixel
    const t = startTime + (x * timePerPixel);
    
    // Direct Nearest Neighbor Logic (No horizontal blur)
    const exactCol = (t / totalDuration) * specWidth;
    
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