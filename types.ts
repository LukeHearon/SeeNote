export type FrequencyScale = 'linear' | 'log' | 'mel';

export interface Annotation {
  id: string;
  toolKey: string; // The key of the annotation tool (e.g., "0", "1") used to create this annotation
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
  frequencyScale: FrequencyScale;
}

export interface AudioMetadata {
  duration: number;
  sampleRate: number;
  channels: number;
}

export interface AnnotationTool {
  key: string;
  text: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  audioDirectory: string;
  annotationDirectory: string;
  outputFormat: 'json' | 'csv' | 'txt';
  createdAt: string;
  lastOpened: string;
  annotationTools: AnnotationTool[];
  spectrogramSettings?: SpectrogramSettings;
  nameGradientColors?: [string, string];
  hideAnnotated?: boolean;
}
