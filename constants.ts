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
export const MAX_ZOOM_SEC = 60;
export const DEFAULT_ZOOM_SEC = 5;
export const SCROLL_SENSITIVITY = 1.0;

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

// Only start with the Default (0) label
export const DEFAULT_LABEL_CONFIGS = [
  { key: "0", text: "Custom Label", color: HOTKEY_COLORS[0] }
];