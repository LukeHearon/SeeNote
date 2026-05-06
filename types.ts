export type FrequencyScale = 'linear' | 'log' | 'mel';

export interface Selection {
  start: number; // seconds
  end: number;   // seconds
}

export interface Annotation {
  id: string;
  toolKey: string; // The key of the annotation tool (e.g., "0", "1") used to create this annotation
  start: number; // Seconds
  end: number;   // Seconds
  text: string;
  color?: string; // Hex color
}

// Annotation with UI-only vertical-dodge layer assigned by calculateAnnotationLayers.
// Never persisted — only used inside Spectrogram rendering.
export type AnnotationWithLayer = Annotation & { layerIndex: number };

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
  key: string | null;  // null = unassigned, "0" = custom, "1"-"9" = hotkey
  text: string;
  color: string;
}

export interface ProjectUiSettings {
  leftPanelWidth?: number;  // px
  splitRatio?: number;      // 0–1, vertical split between video and spectrogram
  leftPanelRatio?: number;  // 0–1, split within left panel (file tree vs tool palette)
  volume?: number;          // gain, 0–4
}

export interface Project {
  id: string;
  name: string;
  audioDirectory: string;
  annotationDirectory: string;
  outputFormat: 'json' | 'csv' | 'txt';
  outputRoundingDecimals?: number; // decimal places for start/end in output files; default 4
  createdAt: string;
  lastOpened: string;
  annotationTools: AnnotationTool[];
  spectrogramSettings?: SpectrogramSettings;
  nameGradientColors?: [string, string];
  fileFilter?: 'all' | 'annotated' | 'unannotated';
  /** @deprecated Use `fileFilter` instead. Kept for backward-compatible reads of old project files. */
  hideAnnotated?: boolean;
  shuffleMode?: boolean;
  uiSettings?: ProjectUiSettings;
}
