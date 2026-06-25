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
  /**
   * Session-stable identity used ONLY to track which on-disk tool folder this
   * tool maps to across edits (so a rename moves the folder instead of
   * delete+recreate). Runtime-only — never written to annotation files or
   * settings. The durable identity on disk is the folder name (= `text`).
   */
  id: string;
  key: string | null;  // null = unassigned, "0" = custom, "1"-"9" = hotkey
  text: string;
  color: string;
  description?: string; // internal memo shown as hover tooltip on annotations
  /** Absolute paths of example audio clips from the folder scan. Runtime-only. */
  exampleFiles?: string[];
}

/**
 * Common playback surface implemented by both AudioEngine and VideoElementEngine.
 * AnnotationWindow's transport layer drives whichever engine is live through this
 * interface (see `activeTransport()`), never branching on the concrete type.
 * Signatures must stay satisfiable by both engines as-is.
 */
export interface PlaybackTransport {
  /** True while playback is actively running. */
  get isPlaying(): boolean;
  /** Current playback position in seconds (last known position while paused). */
  getMediaTime(): number;
  /** Play from `startSec`; if `endSec` is given, stop and fire onEnded there. */
  play(startSec: number, endSec?: number): void;
  pause(): void;
  /** Move the playhead to `sec` without changing the playing state. */
  seek(sec: number): void;
  setGain(gain: number): void;
  setPlaybackSpeed(speed: number): void;
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
  volume?: number;          // gain, 0–4
  playbackSpeed?: number;   // 0.25–4.0, 1.0 = normal
  lastDefinedSpeed?: number;        // last non-1.0 speed picked by user; restored on speed toggle
  zoomSec?: number;                 // spectrogram visible duration
  activeTrackPath?: string | null;  // path of last-opened track, relative to project.mediaDirectoryAbs
  videoMode?: VideoMode;            // see VideoMode docs

  // buzzdetect activations panel (see components/BuzzdetectPanel.tsx).
  buzzdetectEnabled?: boolean;             // panel shown/hidden
  buzzdetectThresholds?: Record<string, number>; // per-neuron logit threshold, keyed by neuron label
  buzzdetectHiddenNeurons?: string[];      // neuron labels deselected via checkboxes

  // Panel layout (see hooks/usePanelLayout.ts).
  playheadLocked?: boolean;
  filePanelCollapsed?: boolean;
  videoCollapsed?: boolean;
  splitRatio?: number;              // video/spectrogram vertical split, 0–1
  leftPanelRatio?: number;          // file-tree vs tool-palette split within left panel, 0–1
  leftPanelWidthRatio?: number;     // left panel width as fraction of window.innerWidth (DPI-independent)
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
 * Contents of `{projectDir}/.seenote/settings.json`. Project-scoped config
 * shared across all users of this project. The project directory itself is
 * implicit — it is the parent of `.seenote/`. Per-user preferences live in
 * `preferences.json` (see ProjectPreferences).
 */
export interface ProjectSettings {
  projectName: string;
  mediaDirectory: ProjectPath;
  annotationDirectory: ProjectPath;
  /** Optional directory of buzzdetect `{ident}_buzzdetect.csv` files. */
  buzzdetectDirectory?: ProjectPath;
  outputFormat: 'txt';
  outputRoundingDecimals?: number;
  nameGradientColors?: [string, string];
  /** GitHub sync remote URL. Per-user token and author live in ProjectPreferences.gitSyncUser. */
  gitSync?: GitSyncConfig;
}

/**
 * Contents of `{projectDir}/.seenote/preferences.json`. Per-project,
 * per-user settings that should not be shared across machines. Not tracked
 * by git. Multiple users of the same synced project each have their own copy.
 */
export interface ProjectPreferences {
  spectrogramSettings?: SpectrogramSettings;
  /**
   * Label → hotkey ("1"–"9"). The tools themselves live as folders under
   * {projectDir}/.seenote/annotation-tools/ (see utils/annotationTools.ts);
   * only the hotkey bindings are stored here.
   */
  toolHotkeys?: Record<string, string>;
  fileFilter?: 'all' | 'annotated' | 'unannotated';
  shuffleMode?: boolean;
  enteredFolderPath?: string;
  uiSettings?: ProjectUiSettings;
  bandPassFilter?: BandPassFilter | null;
  /** Per-user git sync credentials and author identity. */
  gitSyncUser?: GitSyncUserConfig;
}

export interface GitSyncConfig {
  /** HTTPS clone URL of the private annotation repo. */
  remoteUrl: string;
}

/**
 * Per-user git sync settings stored in preferences.json (never pushed to the
 * remote). Kept separate from GitSyncConfig so multiple users sharing the same
 * project can each store their own token and author identity.
 */
export interface GitSyncUserConfig {
  /** Optional commit author name for this machine's user. */
  authorName?: string;
  /**
   * Where this machine keeps the PAT. Default 'keychain'. On unsigned/quarantined
   * builds (no Apple Developer signing), the macOS Keychain prompts for a password
   * on every access; 'plaintext' avoids that by storing the token in this file
   * instead. Safe from remote leakage either way — preferences.json lives in the
   * gitignored .seenote/ dir and is never pushed — but plaintext is readable by
   * anything that can read the file. See utils/gitSync.ts (readSyncToken/applySyncToken).
   */
  tokenStorage?: 'keychain' | 'plaintext';
  /**
   * The PAT, present only when tokenStorage === 'plaintext'. For 'keychain' the
   * token lives in the OS credential store (keyring crate, keyed by remoteUrl)
   * and this field is absent.
   */
  tokenPlaintext?: string;
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
  /** Last-known gradient colors, mirrored from settings.json `nameGradientColors`. */
  nameGradientColors?: [string, string];
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
  preferences: ProjectPreferences;
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
