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
  fftSize: number; // Power of 2 (e.g., 1024, 2048)
  frequencyScale: FrequencyScale;
  displayFloor: number; // dBFS lower bound for display mapping; default -100
  displayCeil: number;  // dBFS upper bound for display mapping; default 0
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
  playbackSpeed?: number;   // 0.25–4.0, 1.0 = normal
}

/**
 * Temporary band-pass filter applied during playback. Source audio is not
 * modified — the filter is realised in the Web Audio graph and removed when
 * the user exits filter mode.
 *
 * `low` and `high` are in Hz. `strength` is a 0–1 wet/dry mix where 0 = no
 * filtering (source untouched) and 1 = pure band-passed signal.
 */
export interface BandPassFilter {
  low: number;
  high: number;
  strength: number;
}

export interface Project {
  id: string;
  name: string;
  audioDirectory: string;
  annotationDirectory: string;
  outputFormat: 'txt';
  outputRoundingDecimals?: number; // decimal places for start/end in output files; default 4
  createdAt: string;
  lastOpened: string;
  annotationTools: AnnotationTool[];
  spectrogramSettings?: SpectrogramSettings;
  nameGradientColors?: [string, string];
  fileFilter?: 'all' | 'annotated' | 'unannotated';
  shuffleMode?: boolean;
  uiSettings?: ProjectUiSettings;
  bandPassFilter?: BandPassFilter | null;
}
