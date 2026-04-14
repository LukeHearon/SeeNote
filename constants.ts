// Roseus 'r' perceptually-uniform colormap
// © 2022 dofuuz — MIT License
// Source: https://github.com/dofuuz/roseus
// 17 stops sampled evenly from the 256-entry dataset (indices 0, 16, 32 … 240, 255)
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
export const DEFAULT_ZOOM_SEC = 10;
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

// Pick two colors independently from the Magma colormap, skipping the dark purple end.
export function randomMagmaGradient(): [string, string] {
  const t1 = 0.2 + Math.random() * 0.8;
  const t2 = 0.2 + Math.random() * 0.8;
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