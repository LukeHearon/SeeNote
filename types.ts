export type FrequencyScale = 'linear' | 'log' | 'mel';

export interface Label {
  id: string;
  configId: string; // The ID of the configuration (e.g., "0", "1") this label belongs to
  start: number; // Seconds
  end: number;   // Seconds
  text: string;
  color?: string; // Hex color
  layerIndex?: number; // Calculated for UI dodge
}

export interface SpectrogramSettings {
  minFreq: number;
  maxFreq: number;
  intensity: number; // Brightness multiplier
  contrast: number; // Contrast multiplier
  fftSize: number; // Power of 2 (e.g., 1024, 2048)
  windowSize: number; // Zoom level (seconds visible)
  frequencyScale: FrequencyScale;
}

export interface AudioMetadata {
  duration: number;
  sampleRate: number;
  channels: number;
}

export interface LabelConfig {
  key: string;
  text: string;
  color: string;
}