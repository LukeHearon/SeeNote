import type { DateTimeFormat } from './utils/datetimeDisplay';

export type FrequencyScale = 'linear' | 'log' | 'mel';

export interface Selection {
  start: number; // seconds
  end: number;   // seconds
  /**
   * The end that was pinned when this selection was drawn, in seconds — so the
   * *other* end is the one the user placed last, and the one Shift+arrow goes
   * on adjusting (see utils/selectionExtend). Optional: a selection made
   * without a direction (typed into the toolbar, bound to an annotation) is
   * adjusted from its end.
   */
  anchor?: number;
}

export interface Annotation {
  id: string;
  start: number; // Seconds
  end: number;   // Seconds
  text: string;
  // Hex color. Denormalized cache derived from the owning tool by matching
  // `text` (white when no tool matches — i.e. a Custom/one-off label). Never
  // written to the annotation file; the tool link is the label itself.
  color?: string;
  // The verbatim on-disk line this annotation was parsed from, when it came
  // from a file. `generateAudacityContent` writes it back unchanged while
  // `start`/`end`/`text` still match it, so saving a file never re-rounds
  // records the user didn't touch (an imported `0.528075` stays `0.528075`
  // instead of becoming `0.5281` and churning the whole file in git). Any edit
  // makes the values disagree with the line, which drops it automatically.
  raw?: string;
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
  /**
   * Position to restart from so resumed playback neither repeats nor skips audio.
   * Distinct from getMediaTime(): the playhead is compensated for output latency
   * (it shows what's *audible*), but audio through the *scheduled* cursor has
   * already been handed to the device and will be heard even after pause() —
   * so resuming from getMediaTime() replays that window. See AudioEngine.
   */
  getResumeTime(): number;
  /** Play from `startSec`; if `endSec` is given, stop and fire onEnded there. */
  play(startSec: number, endSec?: number): void;
  pause(): void;
  /**
   * Drop a bounded play's stop point mid-playback (the selection that set it was
   * cancelled) so playback continues to natural EOF instead of stopping at the
   * now-stale endSec. No-op when not playing or when no end was set.
   */
  clearEndSec(): void;
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
  videoBrightness?: number;         // display-only CSS filter, 0-200, 100 = neutral
  videoContrast?: number;           // display-only CSS filter, 0-200, 100 = neutral

  // buzzdetect activations panel (see components/BuzzdetectPanel.tsx).
  buzzdetectEnabled?: boolean;             // panel shown/hidden
  buzzdetectThresholds?: Record<string, number>; // per-neuron logit threshold, keyed by neuron label
  // Per-neuron threshold the SUBSET is cut at, where it differs from the
  // detection threshold above (activation mode only). Absent = the same value.
  // Per-neuron threshold the SUBSET is cut at. An entry here is what makes a
  // neuron part of the subset — the keys ARE the picked neurons.
  buzzdetectSubsetThresholds?: Record<string, number>;
  buzzdetectHiddenNeurons?: string[];      // neuron labels deselected via checkboxes
  buzzdetectNeuronColors?: Record<string, string>; // per-neuron color override, keyed by neuron label
  buzzdetectSeriesMode?: BuzzdetectSeriesMode; // which series the panel plots
  buzzdetectBinWidthOverride?: number | null; // user-pinned bin width (seconds); null/absent = auto-calculated
  // Subset mode (see utils/subsetTimeline.ts): show only the time where the
  // chosen neurons fired, with the rest removed from the time axis.
  buzzdetectSubsetEnabled?: boolean;       // master toggle; the neuron picks survive turning it off
  /**
   * Legacy: neuron labels the subset was keyed to. Superseded by the keys of
   * `buzzdetectSubsetThresholds` — still read once, on load, to carry an older
   * project's picks across (useBuzzdetect's migrateSubsetThresholds), and no
   * longer written.
   */
  buzzdetectSubsetNeurons?: string[];
  buzzdetectMinDetectionRate?: number;     // 0-1; detection-rate mode's minimum per bin
  buzzdetectSubsetBuffer?: number;         // seconds of context kept either side of each subset bin
  buzzdetectPinnedNeurons?: string[];      // neuron labels pinned to the top of the palette, in pin order

  // Panel layout (see hooks/usePanelLayout.ts).
  playheadLocked?: boolean;
  filePanelCollapsed?: boolean;
  videoCollapsed?: boolean;
  splitRatio?: number;              // video/spectrogram vertical split, 0–1
  /**
   * @deprecated Superseded by `sidebarSections`, which sizes an arbitrary
   * number of sections. Still read on load to seed the file-tree and
   * annotation-tool weights for projects saved before the neuron palette.
   */
  leftPanelRatio?: number;          // file-tree vs tool-palette split within left panel, 0–1
  /**
   * Per-section height weight and collapse state for the left sidebar's stack,
   * keyed by section id (see SIDEBAR_SECTION_IDS in constants.ts). Weights are
   * relative shares, not pixels or fractions of the window.
   */
  sidebarSections?: Record<string, { weight: number; collapsed: boolean }>;
  leftPanelWidthRatio?: number;     // left panel width as fraction of window.innerWidth (DPI-independent)

  // Running-time readout format in the toolbar (see components/Toolbar.tsx).
  // 'datetime' needs the track's start time (parsed from its filename via
  // ProjectSettings.filenameTimeFormat); on a track whose name doesn't parse,
  // readouts fall back to `fallbackTimeDisplayUnit`.
  timeDisplayUnit?: 'seconds' | 'hms' | 'datetime';
  /** Last elapsed-time unit the user picked; the fallback for 'datetime'. */
  fallbackTimeDisplayUnit?: 'seconds' | 'hms';
}

/**
 * Which series the buzzdetect panel plots: the raw per-frame activation, or
 * the fraction of each bin's frames clearing the neuron's threshold.
 */
export type BuzzdetectSeriesMode = 'activation' | 'detectionRate';

/**
 * Parsed buzzdetect activations for one track, returned by `read_buzzdetect`.
 * `values` is indexed `[neuron][frame]`; `neurons` are display labels with any
 * `activation_` prefix already stripped.
 *
 * The frame grid takes two numbers, because the model's `framelength` and
 * `framehop` are independent and only one of them is visible in the CSV:
 *
 *   frameHop     spacing between consecutive `starts`, inferred from the data.
 *   frameLength  how much audio one frame DESCRIBES — the project's frame
 *                length setting, defaulting to the hop. When it exceeds the
 *                hop the frames overlap, and a frame's audio runs past where
 *                the next one begins.
 *
 * A frame's source extent is always `[start, start + frameLength)`. Anything
 * asking "which frames sit on this grid" wants `frameHop` instead.
 */
export interface BuzzdetectData {
  frameLength: number;
  frameHop: number;
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
/**
 * Contents of `{appDataDir}/app_settings.json`. System-wide, shared across
 * every project on this machine (unlike ProjectSettings/ProjectPreferences,
 * which are scoped to a single project). Not tied to git or project sync.
 */
export interface AppSettings {
  /**
   * Path to a custom ffmpeg/ffprobe install (either binary — both are looked
   * up alongside each other), used as a fallback decode backend for formats
   * symphonia can't handle (currently just .wma). When unset, falls back to
   * PATH lookup.
   */
  ffmpegPath?: string;
}

export interface ProjectSettings {
  projectName: string;
  mediaDirectory: ProjectPath;
  annotationDirectory: ProjectPath;
  /**
   * Optional pattern describing the timestamp embedded in media filenames
   * (e.g. "YYMMDD_HHMM"). When a track's name matches, its times can be shown
   * as wall-clock datetimes. See utils/filenameTime.ts for the token set.
   */
  filenameTimeFormat?: string;
  /**
   * Optional separator (e.g. "_s") marking an elapsed-seconds offset in media
   * filenames, added on top of the time parsed via `filenameTimeFormat`
   * (e.g. "..._s52860.mp3" adds 52860s). The digits between the separator and
   * the extension must parse as an integer, or the offset is silently
   * ignored. See utils/filenameTime.ts.
   */
  filenameTimeOffsetSeparator?: string;
  /** Optional directory of buzzdetect `{ident}_buzzdetect.csv` files. */
  buzzdetectDirectory?: ProjectPath;
  /** Frame length in seconds, used as a fallback bin width when it can't be
   *  inferred from a CSV's `start` column (e.g. fewer than 2 rows). */
  buzzdetectFrameLength?: number;
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
  /**
   * Automatically pull (fetch + merge, never push) remote annotation changes
   * on project open and on the sync heartbeat, so the working tree never sits
   * behind the remote. Defaults to on — undefined (older preferences.json
   * files predating this setting) is treated as enabled. Set in the
   * Preferences tab of project settings.
   */
  autoPullRemoteChanges?: boolean;
  /** Interpret the Find Label search query as a regular expression instead of an exact match. */
  findLabelUseRegex?: boolean;
  /** Match the Find Label search query anywhere in a label instead of requiring an exact match. No effect when findLabelUseRegex is on (regex matching is already unanchored). */
  findLabelPartialMatch?: boolean;
  /**
   * Style used to render wall-clock datetimes (spectrogram ruler, running
   * time, and the From/To selection fields) when `ProjectUiSettings.timeDisplayUnit`
   * is 'datetime'. Set in the Preferences tab of project settings.
   */
  dateTimeFormat?: DateTimeFormat;
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

/**
 * Pointer record in the per-machine registry at
 * `{app_data}/.projects/files.json`. Tracks single files opened outside of
 * any project (see `SingleFileWindow`) for the launch screen's recent list.
 */
export interface RecentFileEntry {
  id: string;
  path: string; // absolute, this-machine path
  lastOpened: string; // ISO timestamp
}
