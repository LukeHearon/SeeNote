import type { AnnotationTool, ProjectUiSettings, SpectrogramSettings, VideoMode } from './types';

// Roseus 'r' perceptually-uniform colormap
// © 2022 dofuuz — MIT License
// Source: https://github.com/dofuuz/roseus
// 17 stops sampled evenly from the 256-entry dataset (indices 0, 16, 32 … 240, 255)
export const MAGMA_STOPS = [
  { pos: 0.00, r: 0,   g: 0,   b: 0   },  // True black (noise floor)
  { pos: 0.07, r: 28,  g: 15,  b: 70  },  // Midnight purple
  { pos: 0.2,  r: 80,  g: 17,  b: 123 },  // Purple
  { pos: 0.4,  r: 180, g: 53,  b: 120 },  // Red-Purple
  { pos: 0.6,  r: 230, g: 81,  b: 97  },  // Orange-Red
  { pos: 0.8,  r: 249, g: 195, b: 135 },  // Orange-Yellow
  { pos: 1.0,  r: 250, g: 251, b: 198 },  // White-Yellow
];

// Extensions that the Rust symphonia decoder can actually decode.
// Files with other extensions are still scanned and shown in the file panel,
// but marked "(unsupported)" and disabled — we can't produce audio or a
// spectrogram for them. Keep in sync with src-tauri/Cargo.toml symphonia
// features and VideoPlayer's <video> capability.
// ogg intentionally omitted: symphonia 0.5's ogg/vorbis path hangs on decode
// in our environment (play button never unsticks). Revisit if/when we swap
// decoders or upgrade symphonia. Ogg files are still scanned and shown, just
// grayed as (unsupported) so users aren't surprised by silent failures.
export const SUPPORTED_AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'aac', 'm4a']);
export const SUPPORTED_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm']);

// Canonical on-disk extension for internal annotation files (no leading dot).
// Annotations use one shared internal format (currently Audacity tab-delimited
// `.txt`) — NOT user-configurable. May become 'yaml' in a future format
// migration. Mirror of Rust `ANNOTATION_EXT` in src-tauri/src/commands/shared.rs;
// change both together. git-sync uses this to decide which files are tracked and
// set-merged.
export const ANNOTATION_FILE_EXT = 'txt';

// Lowercased file extension (no dot), or '' if the path has no extension.
export function getExt(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

export function isSupportedMediaFile(path: string): boolean {
  const ext = getExt(path);
  return SUPPORTED_AUDIO_EXTS.has(ext) || SUPPORTED_VIDEO_EXTS.has(ext);
}

export const MIN_ZOOM_SEC = 1;
export const DEFAULT_ZOOM_SEC = 10;

// Canonical default for output rounding (used when project.outputRoundingDecimals is unset).
export const DEFAULT_OUTPUT_ROUNDING_DECIMALS = 4;

// Canonical defaults for every persisted setting. Every load site reads from
// here so a default never has to be repeated. New persisted fields should be
// added here first, then referenced from useState/load paths.
export const DEFAULT_SPECTROGRAM_SETTINGS: SpectrogramSettings = {
  minFreq: 0,
  maxFreq: 10000,
  fftSize: 2048,
  frequencyScale: 'mel',
  displayFloor: -100,
  displayCeil: 0,
};

// Panel layout defaults (not persisted — layout is local, not shared).
export const DEFAULT_LEFT_PANEL_WIDTH = 224; // px
export const DEFAULT_SPLIT_RATIO = 0.5;      // vertical video/spectrogram split
export const DEFAULT_LEFT_PANEL_RATIO = 0.6; // file-tree vs tool-palette split

export const DEFAULT_UI_SETTINGS: Required<Omit<ProjectUiSettings,
  'activeTrackPath' |
  'buzzdetectEnabled' | 'buzzdetectThresholds' | 'buzzdetectHiddenNeurons'>> = {
  volume: 1,
  playbackSpeed: 1,
  lastDefinedSpeed: 1.5,
  zoomSec: DEFAULT_ZOOM_SEC,
  videoMode: 'accurate',
};

// Coerce a persisted videoMode to the current enum. The experimental
// 'fast-slave' / 'fast-free' variants (and the original audio-master 'fast')
// all collapse into the single 'fast' mode (video element plays its own audio).
// Legacy 'high' migrates to 'accurate'.
export function migrateVideoMode(mode: VideoMode | string | undefined): VideoMode {
  if (mode === 'fast' || mode === 'fast-slave' || mode === 'fast-free') return 'fast';
  if (mode === 'high') return 'accurate';
  if (mode === 'off' || mode === 'mixed' || mode === 'accurate') return mode;
  return DEFAULT_UI_SETTINGS.videoMode;
}

// buzzdetect activations panel defaults.
export const DEFAULT_BUZZDETECT_PANEL_HEIGHT = 180; // px
export const MIN_BUZZDETECT_PANEL_HEIGHT = 80;
export const MAX_BUZZDETECT_PANEL_HEIGHT = 600;
// Logits: 0 is the natural decision boundary (sigmoid 0.5). Used per neuron
// until the user sets a custom threshold.
export const DEFAULT_BUZZDETECT_THRESHOLD = 0;

// Categorical palette for neuron polylines, assigned by neuron order. Chosen to
// read clearly on the slate-900 panel background and stay distinct from the
// magma spectrogram colormap.
export const BUZZDETECT_PALETTE = [
  '#38bdf8', // sky
  '#fbbf24', // amber
  '#4ade80', // green
  '#f472b6', // pink
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#facc15', // yellow
  '#fb923c', // orange
  '#34d399', // emerald
  '#e879f9', // fuchsia
  '#60a5fa', // blue
  '#a3e635', // lime
];

export const buzzdetectNeuronColor = (neuronIndex: number): string =>
  BUZZDETECT_PALETTE[neuronIndex % BUZZDETECT_PALETTE.length];

// Used when the user engages the band-pass filter (F key or slider drag-up
// from 0) without ever having drawn a band: an audible mid-range default so
// the filter does something immediately, and the user can refine cutoffs from
// there with the filter tool.
export const DEFAULT_BAND_PASS_FILTER = { low: 500, high: 4000, strength: 0.5 };
// Minimum hold duration (ms) that counts as an intentional drag even if the pointer barely moved
export const DRAG_INTENT_HOLD_MS = 250;

// Multi-resolution spectrogram tier configuration.
// Each tier defines a temporal resolution for a range of zoom levels.
// hopMultiplier: hop = sampleRate * multiplier (for tiers scaled to sample rate)
// hopSamples: fixed hop size in samples (for fine-detail tiers)
export interface TierConfig {
  tier: number;
  hopMultiplier?: number;  // hop = sampleRate * multiplier
  hopSamples?: number;     // fixed hop size (takes precedence if set)
  chunkDuration: number;   // seconds per cached chunk
  maxChunks: number;       // LRU cache capacity for this tier
}

export const TIER_CONFIGS: TierConfig[] = [
  { tier: 0, hopMultiplier: 1.0,   chunkDuration: 600, maxChunks: 6  },
  { tier: 1, hopMultiplier: 0.1,   chunkDuration: 120, maxChunks: 8  },
  { tier: 2, hopSamples: 1024,     chunkDuration: 30,  maxChunks: 12 },
  { tier: 3, hopSamples: 512,      chunkDuration: 15,  maxChunks: 16 },
];

// Interpolate the Roseus/Magma colormap at position t in [0, 1] and return a hex color string.
export function interpolateMagmaHex(t: number): string {
  t = Math.max(0, Math.min(1, t));
  let lower = MAGMA_STOPS[0];
  let upper = MAGMA_STOPS[MAGMA_STOPS.length - 1];
  for (let i = 0; i < MAGMA_STOPS.length - 1; i++) {
    if (t >= MAGMA_STOPS[i].pos && t <= MAGMA_STOPS[i + 1].pos) {
      lower = MAGMA_STOPS[i];
      upper = MAGMA_STOPS[i + 1];
      break;
    }
  }
  const range = upper.pos - lower.pos;
  const localT = range === 0 ? 0 : (t - lower.pos) / range;
  const r = Math.round(lower.r + localT * (upper.r - lower.r));
  const g = Math.round(lower.g + localT * (upper.g - lower.g));
  const b = Math.round(lower.b + localT * (upper.b - lower.b));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Shared lower clamp for magma color selection. Both the gradient randomizer
// and the GradientPicker constrain t to [MAGMA_MIN_T, 1] so handles can't reach
// the pure-black end of the colormap (which looks bad for project name colors).
export const MAGMA_MIN_T = 0.2;

// Pick two colors independently from the Magma colormap, skipping the dark purple end.
export function randomMagmaGradient(): [string, string] {
  const t1 = MAGMA_MIN_T + Math.random() * (1 - MAGMA_MIN_T);
  const t2 = MAGMA_MIN_T + Math.random() * (1 - MAGMA_MIN_T);
  return [interpolateMagmaHex(t1), interpolateMagmaHex(t2)];
}

// Default colors for hotkeys 1-9
export const HOTKEY_COLORS = [
  "#ffffff", // 0 (Default/Custom) - White
  "#ef4444", // 1 Red
  "#f97316", // 2 Orange
  "#eab308", // 3 Yellow
  "#22c55e", // 4 Green
  "#06b6d4", // 5 Cyan
  "#3b82f6", // 6 Blue
  "#a855f7", // 7 Purple
  "#ec4899", // 8 Pink
  "#64748b", // 9 Slate
];

// Seed tools for new projects. CreateProjectModal creates a tool folder under
// .seenote/annotation-tools/ for each non-Custom entry and builds the initial
// settings.toolHotkeys from the keys, so a fresh project is usable out of the
// box. Not used after project creation — the folders are the source of truth.
//
// IMPORTANT: Key "0" is ALWAYS reserved for the Custom Annotation Tool. When
// this tool is active, new annotations get an empty text field so the user can
// type a one-off name without creating a new named annotation tool. The
// autoFocus on the annotation text input is triggered by `text === ""`, which
// depends on key "0" staying as the Custom Annotation Tool. Do NOT replace
// key "0" with a defined annotation tool — doing so silently breaks the
// custom annotation UX. The Custom entry below only seeds customToolColor;
// it never becomes a folder.
export type SeedTool = Omit<AnnotationTool, 'id'>;
export const DEFAULT_TOOL_SEED: SeedTool[] = [
  { key: "0", text: "Custom",            color: HOTKEY_COLORS[0] },
  { key: "1", text: "ins_buzz_high",     color: HOTKEY_COLORS[1], description: "Flight buzz higher in pitch than honey bee; perhaps small solitary bees, mosquitoes, flies" },
  { key: "2", text: "ins_buzz_medium",   color: HOTKEY_COLORS[2], description: "Flight buzz similar to that of a honey bee" },
  { key: "3", text: "ins_buzz_low",      color: HOTKEY_COLORS[3], description: "Flight buzz lower in pitch than honey bee; perhaps bumble bees or other large insects" },
  { key: "4", text: "ins_trill",         color: HOTKEY_COLORS[4], description: "Sharp or background chirping or tymbaling as of crickets, cicadas, katydids" },
  { key: "5", text: "mech_auto",         color: HOTKEY_COLORS[5], description: "Ground-based vehicle: trucks, cars, motorcycles" },
  { key: "6", text: "mech_plane",        color: HOTKEY_COLORS[6], description: "Aircraft in flight: propeller planes or jets" },
  { key: "7", text: "ambient_scraping",  color: HOTKEY_COLORS[7], description: "The sound of something scraping over the recorder or its stake, amplified by contact" },
  { key: "8", text: "ambient_bang",      color: HOTKEY_COLORS[8], description: "Brief, loud, atonal sound: gunshot, car backfire, firework" },
  { key: null, text: "ambient_rain",     color: HOTKEY_COLORS[9], description: "The pitter patter of rain drops or heavy rainfall, often amplified by drumming against the rain cover" },
  { key: null, text: "ambient_rustle",   color: HOTKEY_COLORS[9], description: "Wind swishing leaves; not sharp and amplified like ambient_scraping" },
  { key: null, text: "mech_hum_traffic", color: HOTKEY_COLORS[9], description: "Far-off continuous drone of distant highway traffic" },
  { key: null, text: "human",            color: HOTKEY_COLORS[9], description: "Human vocalization; speaking, laughing, etc." },
  { key: null, text: "animal_frog",      color: HOTKEY_COLORS[9], description: "Any frog call" },
];

export function pickNextToolColor(existingTools: AnnotationTool[]): string {
  const usedColors = new Set(existingTools.map(t => t.color));
  for (let i = 1; i <= 9; i++) {
    if (!usedColors.has(HOTKEY_COLORS[i])) return HOTKEY_COLORS[i];
  }
  return HOTKEY_COLORS[1];
}