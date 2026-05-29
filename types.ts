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
  description?: string; // internal memo shown as hover tooltip on annotations
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Video rendering pipeline for the active track.
 *  - 'off':   no video element at all (audio-only via AudioEngine)
 *  - 'fast':  the `<video>` element displays the picture AND plays its own audio
 *             track, free-running with the browser's built-in A/V sync. Cheap and
 *             smooth, but NOT sample-accurate with the spectrogram: no band-pass
 *             filter, no pitch-preserving slow-down (speed changes pitch), and the
 *             playhead tracks the element's coarse clock. For machines that can't
 *             run Accurate. Driven by VideoElementEngine.
 *  - 'mixed': 'fast' until a selection is committed, then frame-accurate canvas
 *             (WebCodecs + AudioEngine) for the selected region. Falls back to the
 *             <video> element on non-MP4/MOV files.
 *  - 'accurate': always the WebCodecs+canvas path with AudioEngine (frame-accurate).
 *             Default.
 *
 * Legacy values ('fast-slave', 'fast-free', and the original audio-master 'fast')
 * all migrate to 'fast' on load — see migrateVideoMode() in constants.ts.
 * Legacy value 'high' migrates to 'accurate'.
 */
export type VideoMode = 'off' | 'fast' | 'mixed' | 'accurate';

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
  videoMode?: VideoMode;            // see VideoMode docs

  // buzzdetect activations panel (see components/BuzzdetectPanel.tsx).
  buzzdetectEnabled?: boolean;             // panel shown/hidden
  buzzdetectThresholds?: Record<string, number>; // per-neuron logit threshold, keyed by neuron label
  buzzdetectHiddenNeurons?: string[];      // neuron labels deselected via checkboxes
  buzzdetectPanelHeight?: number;          // px height of the panel
}

/**
 * Parsed buzzdetect activations for one track, returned by `read_buzzdetect`.
 * `values` is indexed `[neuron][frame]`; `neurons` are display labels with any
 * `activation_` prefix already stripped. `binWidth` is inferred from `starts`.
 */
export interface BuzzdetectData {
  binWidth: number;
  neurons: string[];
  starts: number[];
  values: number[][];
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
  /** Optional directory of buzzdetect `{ident}_buzzdetect.csv` files. */
  buzzdetectDirectory?: ProjectPath;
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
  /**
   * Last-known project name, mirrored from settings.json `name` whenever the
   * project resolves cleanly. Lets a project that has gone missing still show
   * its real name in the launch list, and lets "Locate" verify the user is
   * re-linking to the same project rather than a different one.
   */
  name?: string;
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
  /** Resolved absolute buzzdetect directory, or null when not configured. */
  buzzdetectDirectoryAbs: string | null;
}

/** Existence of one of a project's configured directories, reported during re-link. */
export interface RelinkDirStatus {
  label: string;   // 'Media' | 'Annotations' | 'buzzdetect'
  path: string;    // resolved absolute path that was checked
  exists: boolean;
}

/**
 * Snapshot handed to the re-link confirmation UI: which directories were found
 * at the chosen location, and whether the on-disk project name differs from the
 * name SeeNote has listed for this entry.
 */
export interface RelinkInfo {
  internalName: string;  // name SeeNote has on file for this entry (registry / folder)
  settingsName: string;  // name read from the chosen folder's .seenote/settings.json
  nameConflict: boolean;
  dirs: RelinkDirStatus[];
}

/** The user's decision in the re-link confirmation UI. `name` is the name to keep.
 *  `dirOverrides` maps label ('Media' | 'Annotations' | 'buzzdetect') → new absolute path
 *  for any directories the user relocated via the "Locate" button. */
export type RelinkResolution =
  | { action: 'cancel' }
  | { action: 'relink'; name: string; dirOverrides?: Record<string, string> };

/**
 * One row in the launch screen list. `ok` entries have a fully-loaded
 * `project`; `unchecked` entries haven't been validated against disk yet
 * (the launch screen avoids proactive filesystem access so macOS doesn't
 * fire a TCC consent prompt for every registered project); other variants
 * only have the registry pointer so the user can be prompted to remove or
 * reconnect.
 */
export type ProjectListEntry =
  | { status: 'unchecked'; registry: ProjectRegistryEntry }
  | { status: 'ok'; registry: ProjectRegistryEntry; project: Project }
  | { status: 'missing-dir'; registry: ProjectRegistryEntry }
  | { status: 'bad-settings'; registry: ProjectRegistryEntry; error: string };
