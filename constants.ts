// Approximated Magma Color Map (0.0 to 1.0)
// We will interpolate between these stops
export const MAGMA_STOPS = [
  { pos: 0.0, r: 28,  g: 15,  b: 70  },   // Midnight purple
  { pos: 0.2, r: 80,  g: 17,  b: 123 },  // Purple
  { pos: 0.4, r: 180, g: 53,  b: 120 },  // Red-Purple
  { pos: 0.6, r: 230, g: 81,  b: 97  },  // Orange-Red
  { pos: 0.8, r: 249, g: 195, b: 135 },  // Orange-Yellow
  { pos: 1.0, r: 250, g: 251, b: 198 },  // White-Yellow
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

// Default species labels for new projects
export const DEFAULT_LABEL_CONFIGS = [
  { key: "0", text: "ins_buzz_high",    color: HOTKEY_COLORS[0] },
  { key: "1", text: "ins_buzz_medium",  color: HOTKEY_COLORS[1] },
  { key: "2", text: "ins_buzz_low",     color: HOTKEY_COLORS[2] },
  { key: "3", text: "ambient_scraping", color: HOTKEY_COLORS[3] },
  { key: "4", text: "ambient_rustle",   color: HOTKEY_COLORS[4] },
  { key: "5", text: "ambient_bang",     color: HOTKEY_COLORS[5] },
  { key: "6", text: "ins_trill_cicada", color: HOTKEY_COLORS[6] },
  { key: "7", text: "ins_trill_cricket",color: HOTKEY_COLORS[7] },
];