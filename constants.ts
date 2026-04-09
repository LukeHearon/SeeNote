// Roseus 'r' perceptually-uniform colormap
// © 2022 dofuuz — MIT License
// Source: https://github.com/dofuuz/roseus
// 17 stops sampled evenly from the 256-entry dataset (indices 0, 16, 32 … 240, 255)
export const MAGMA_STOPS = [
  { pos: 0.000, r: 0,   g: 0,   b: 0   },
  { pos: 0.063, r: 19,  g: 9,   b: 2   },
  { pos: 0.125, r: 46,  g: 19,  b: 1   },
  { pos: 0.188, r: 76,  g: 24,  b: 1   },
  { pos: 0.251, r: 103, g: 24,  b: 10  },
  { pos: 0.314, r: 130, g: 21,  b: 30  },
  { pos: 0.376, r: 156, g: 14,  b: 65  },
  { pos: 0.439, r: 176, g: 14,  b: 106 },
  { pos: 0.502, r: 191, g: 32,  b: 152 },
  { pos: 0.565, r: 197, g: 60,  b: 196 },
  { pos: 0.627, r: 195, g: 93,  b: 229 },
  { pos: 0.690, r: 190, g: 127, b: 248 },
  { pos: 0.753, r: 186, g: 158, b: 254 },
  { pos: 0.816, r: 192, g: 188, b: 252 },
  { pos: 0.878, r: 207, g: 212, b: 247 },
  { pos: 0.941, r: 230, g: 233, b: 246 },
  { pos: 1.000, r: 255, g: 250, b: 250 },
];

export const MIN_ZOOM_SEC = 1;
export const MAX_ZOOM_SEC = 86400; // 24 hours — clamped to file duration at runtime
export const DEFAULT_ZOOM_SEC = 5;
export const SCROLL_SENSITIVITY = 1.0;

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

// Default label configs for new projects.
//
// IMPORTANT: Key "0" is ALWAYS reserved for "Custom Label". When this label
// is active, new annotations get an empty text field so the user can type a
// one-off event name without creating a new named category. The autoFocus on
// the annotation text input is triggered by `text === ""`, which depends on
// key "0" staying as Custom Label. Do NOT replace key "0" with a species
// label — doing so silently breaks the custom-label UX.
export const DEFAULT_LABEL_CONFIGS = [
  { key: "0", text: "Custom Label",      color: HOTKEY_COLORS[0] },
  { key: "1", text: "ins_buzz_high",     color: HOTKEY_COLORS[1] },
  { key: "2", text: "ins_buzz_medium",   color: HOTKEY_COLORS[2] },
  { key: "3", text: "ins_buzz_low",      color: HOTKEY_COLORS[3] },
  { key: "4", text: "ambient_scraping",  color: HOTKEY_COLORS[4] },
  { key: "5", text: "ambient_rustle",    color: HOTKEY_COLORS[5] },
  { key: "6", text: "ambient_bang",      color: HOTKEY_COLORS[6] },
  { key: "7", text: "ins_trill_cicada",  color: HOTKEY_COLORS[7] },
  { key: "8", text: "ins_trill_cricket", color: HOTKEY_COLORS[8] },
];