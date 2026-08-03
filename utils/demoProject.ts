import { Annotation, AnnotationTool, BuzzdetectData, SpectrogramSettings } from '../types';

// A small fake project for the help guide to render its example panels against.
//
// The guide documents the app by embedding the app's own components. Some of
// those — the file tree, the buzzdetect panel — are meaningless without data,
// and mirroring the open project's data across the window boundary is either
// too large (a file list is thousands of paths) or meaningless out of context
// (the buzzdetect panel's x-axis is the spectrogram's viewport, which the guide
// window doesn't have). Those panels render against this instead, and say so.
//
// This is fixture data for the REAL components, not a mock of them: if a
// component's props change, this stops compiling. Keep it small — it exists to
// make a control legible, not to simulate a project.

export const DEMO_DURATION = 137.5;
export const DEMO_ROOT = '/Recordings/hive-3';
export const DEMO_TRACK = `${DEMO_ROOT}/2024-06-14/morning-08h.wav`;
/** The example track's ident — its project-relative path, minus the extension. */
export const DEMO_IDENT = '2024-06-14/morning-08h';
/** Wall-clock start the example track's name implies, so the guide's copy of
 *  the time readout can demonstrate the Date unit with no project open. */
export const DEMO_TRACK_START = new Date(2024, 5, 14, 8, 0, 0);

export const demoSpectrogramSettings: SpectrogramSettings = {
  minFreq: 0,
  maxFreq: 12000,
  fftSize: 1024,
  frequencyScale: 'linear',
  displayFloor: -100,
  displayCeil: 0,
};

/** Index 0 is the Custom tool (key "0"), as in a real project. */
export const demoAnnotationTools: AnnotationTool[] = [
  { id: 'demo-custom', key: '0', text: 'Custom', color: '#64748b' },
  { id: 'demo-1', key: '1', text: 'Buzz', color: '#e65161', description: 'Wingbeat buzz' },
  { id: 'demo-2', key: '2', text: 'Song', color: '#38bdf8' },
  { id: 'demo-3', key: '3', text: 'Call', color: '#a78bfa' },
  { id: 'demo-4', key: '4', text: 'Noise', color: '#facc15' },
];

const toolColor = (text: string) => demoAnnotationTools.find(t => t.text === text)?.color;

/** Enough annotations for the rename/search panels to have something to count. */
export const demoAnnotations: Annotation[] = [
  { id: 'a1', start: 4.2, end: 6.8, text: 'Buzz' },
  { id: 'a2', start: 12.0, end: 13.4, text: 'Song' },
  { id: 'a3', start: 21.7, end: 24.9, text: 'Buzz' },
  { id: 'a4', start: 38.5, end: 41.2, text: 'Call' },
  { id: 'a5', start: 55.1, end: 58.0, text: 'Buzz' },
  { id: 'a6', start: 72.4, end: 74.0, text: 'Noise' },
  { id: 'a7', start: 96.3, end: 99.8, text: 'Song' },
  { id: 'a8', start: 118.0, end: 121.5, text: 'Buzz' },
].map(a => ({ ...a, color: toolColor(a.text) }));

/** A couple of folders deep, so expand/collapse and "enter folder" mean something. */
export const demoFiles: string[] = [
  `${DEMO_ROOT}/2024-06-14/morning-08h.wav`,
  `${DEMO_ROOT}/2024-06-14/morning-09h.wav`,
  `${DEMO_ROOT}/2024-06-14/midday-12h.wav`,
  `${DEMO_ROOT}/2024-06-14/evening-19h.wav`,
  `${DEMO_ROOT}/2024-06-15/morning-08h.wav`,
  `${DEMO_ROOT}/2024-06-15/midday-12h.wav`,
  `${DEMO_ROOT}/2024-06-15/entrance-cam.mp4`,
  `${DEMO_ROOT}/reference/known-queen-piping.wav`,
];

/** The tracks the file tree shows a "done" marker against. */
export const demoAnnotatedTracks = new Set<string>([
  `${DEMO_ROOT}/2024-06-14/morning-08h.wav`,
  `${DEMO_ROOT}/2024-06-14/midday-12h.wav`,
  `${DEMO_ROOT}/2024-06-15/morning-08h.wav`,
]);

export const demoNonMediaFiles: string[] = [`${DEMO_ROOT}/2024-06-14/field-notes.txt`];

export const DEMO_BIN_WIDTH = 0.96;
export const DEMO_NEURONS = ['bee', 'bird', 'insect', 'ambient'];
// The demo series run 0–1 rather than as logits, so the real default threshold
// (0, the logit decision boundary) would put every frame over the line and
// leave the guide's dots uniformly filled and its subset keeping everything.
// Half-scale is where these curves actually separate.
export const DEMO_THRESHOLD = 0.5;

/**
 * Synthetic activation series — three bursts of "bee" with the other neurons
 * moving against them, so thresholds, hiding and the detection-rate mode all
 * have something to bite on. Deterministic: the guide must not redraw
 * differently every time it opens.
 */
export function makeDemoBuzzdetectData(): BuzzdetectData {
  const binCount = Math.floor(DEMO_DURATION / DEMO_BIN_WIDTH);
  const starts = Array.from({ length: binCount }, (_, i) => i * DEMO_BIN_WIDTH);

  // Cheap deterministic hash-noise — no seeded RNG dependency for four rows.
  const noise = (i: number, salt: number) => {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const burst = (t: number, centre: number, width: number) =>
    Math.exp(-((t - centre) ** 2) / (2 * width ** 2));

  const values = DEMO_NEURONS.map((neuron, n) => starts.map((t, i) => {
    const wobble = 0.12 * noise(i, n);
    switch (neuron) {
      case 'bee':
        return Math.min(1, 0.08 + wobble + 0.85 * (burst(t, 22, 5) + burst(t, 57, 7) + burst(t, 119, 4)));
      case 'bird':
        return Math.min(1, 0.06 + wobble + 0.7 * (burst(t, 12, 3) + burst(t, 97, 6)));
      case 'insect':
        return Math.min(1, 0.15 + wobble + 0.4 * burst(t, 73, 9));
      default:
        return Math.min(1, 0.25 + 0.3 * wobble + 0.1 * Math.sin(t / 7));
    }
  }));

  return { binWidth: DEMO_BIN_WIDTH, neurons: DEMO_NEURONS, starts, values };
}
