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

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectUiSettings {
  leftPanelWidth?: number;  // px
  splitRatio?: number;      // 0–1, vertical split between video and spectrogram
  leftPanelRatio?: number;  // 0–1, split within left panel (file tree vs tool palette)
  volume?: number;          // gain, 0–4
  playbackSpeed?: number;   // 0.25–4.0, 1.0 = normal
  lastDefinedSpeed?: number;        // last non-1.0 speed picked by user; restored on speed toggle
  zoomSec?: number;                 // spectrogram visible duration
  activeTrackPath?: string | null;  // path of last-opened track, relative to project.mediaDirectoryAbs
  windowBounds?: WindowBounds;      // app window position and size
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

/**
 * A directory path stored in project settings. `relative` paths are resolved
 * against the project directory; `absolute` paths are taken as-is. Choosing
 * `relative` whenever possible is what makes a project portable across
 * machines.
 */
export type ProjectPath =
  | { kind: 'relative'; path: string }
  | { kind: 'absolute'; path: string };

/**
 * Contents of `{projectDir}/.seenote/settings.json`. The project directory
 * itself is implicit — it is the parent of `.seenote/`. The registry entry
 * provides `projectDir` to the in-memory `Project`.
 */
export interface ProjectSettings {
  name: string;
  mediaDirectory: ProjectPath;
  annotationDirectory: ProjectPath;
  outputFormat: 'txt';
  outputRoundingDecimals?: number;
  annotationTools: AnnotationTool[];
  spectrogramSettings?: SpectrogramSettings;
  nameGradientColors?: [string, string];
  fileFilter?: 'all' | 'annotated' | 'unannotated';
  shuffleMode?: boolean;
  uiSettings?: ProjectUiSettings;
  bandPassFilter?: BandPassFilter | null;
}

/**
 * Pointer record in the per-machine registry at
 * `{app_data}/.projects/projects.json`. Holds only what is needed to locate
 * the project on this machine and order the launch list.
 */
export interface ProjectRegistryEntry {
  id: string;
  projectDir: string; // absolute, this-machine path
  lastOpened: string; // ISO timestamp
}

/**
 * In-memory project bundle assembled from a `ProjectRegistryEntry` plus the
 * project's loaded `ProjectSettings`. The `mediaDirectoryAbs` /
 * `annotationDirectoryAbs` fields are resolved on load and are what the rest
 * of the app uses for filesystem calls.
 */
export interface Project {
  id: string;
  projectDir: string;
  lastOpened: string;
  settings: ProjectSettings;
  mediaDirectoryAbs: string;
  annotationDirectoryAbs: string;
}

/**
 * One row in the launch screen list. `ok` entries have a fully-loaded
 * `project`; other variants only have the registry pointer so the user can
 * be prompted to remove or reconnect.
 */
export type ProjectListEntry =
  | { status: 'ok'; registry: ProjectRegistryEntry; project: Project }
  | { status: 'missing-dir'; registry: ProjectRegistryEntry }
  | { status: 'bad-settings'; registry: ProjectRegistryEntry; error: string };
