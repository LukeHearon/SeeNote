import { Annotation, AnnotationTool, AnnotationWithLayer } from '../types';
import { saveFileDialog, writeTextFile, listDirectory } from './tauriCommands';
import { formatDateTime, DateTimeFormat } from './datetimeDisplay';

// Clamp `v` into the inclusive range [lo, hi]. Assumes lo <= hi.
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

// Return a new annotations array with the annotation matching `id` replaced by
// `updater(a)`; all others are passed through unchanged (inputs not mutated).
export const updateAnnotation = (
  annotations: Annotation[],
  id: string | null,
  updater: (a: Annotation) => Annotation,
): Annotation[] => annotations.map(a => (a.id === id ? updater(a) : a));

export const formatTime = (seconds: number, decimals: number = 2): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const scale = 10 ** decimals;
  const frac = Math.floor((seconds % 1) * scale).toString().padStart(decimals, '0');
  const secStr = decimals > 0 ? `${s}.${frac}s` : `${s}s`;
  if (h > 0) return `${h}h${m}m${secStr}`;
  if (m > 0) return `${m}m${secStr}`;
  return secStr;
};

export type TimeDisplayUnit = 'seconds' | 'hms' | 'datetime';

/** The units that are always available — 'datetime' needs a parsed track start. */
export type ElapsedTimeDisplayUnit = 'seconds' | 'hms';

// Plain seconds with a thousands separator, e.g. "123,456.78s".
export const formatSeconds = (seconds: number, decimals: number = 2): string =>
  `${seconds.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}s`;

/**
 * The unit actually used for display. 'datetime' is only honoured when the
 * track's start time is known (its filename parsed against the project's
 * timestamp format); otherwise readouts fall back to `fallback`, the last
 * elapsed-time unit the user chose.
 */
export const effectiveTimeUnit = (
  unit: TimeDisplayUnit,
  trackStartDate: Date | null,
  fallback: ElapsedTimeDisplayUnit,
): TimeDisplayUnit => (unit === 'datetime' && !trackStartDate ? fallback : unit);

// Formats a running time in the user's chosen unit — plain seconds
// ("123,456.78s"), hours/minutes/seconds ("1h15m00.00s", see formatTime), or a
// wall-clock datetime ("2026-07-31 16:56:04.25") when the track's start time is
// known. Without a start time 'datetime' degrades to plain seconds; callers
// that have a user fallback should resolve it with effectiveTimeUnit first.
export const formatTimeForUnit = (
  seconds: number,
  unit: TimeDisplayUnit,
  decimals: number = 2,
  trackStartDate: Date | null = null,
  dateTimeFormat: DateTimeFormat = 'iso',
): string => {
  if (unit === 'datetime' && trackStartDate) return formatDateTime(trackStartDate, seconds, decimals, dateTimeFormat);
  if (unit === 'hms') return formatTime(seconds, decimals);
  return formatSeconds(seconds, decimals);
};

/**
 * Fewest decimal places that show every one of `values` exactly, up to
 * `maxDecimals`. For a readout over a set of times this keeps the precision
 * the values themselves carry — whole-second bin edges read as "4s", and a
 * 4.3s edge pushes the whole readout to "4.3s"–"10.0s" rather than showing one
 * value more precisely than its neighbour. Beyond maxDecimals it gives up and
 * rounds, exactly as a fixed-precision format would.
 */
export const decimalsForTimes = (values: number[], maxDecimals: number = 2): number => {
  const decimalsFor = (v: number): number => {
    // The question is never "is this exactly round?" — it's "would the decimals
    // I'd otherwise print be anything but zeros?". So snap to the most this can
    // ever show, then drop the places that came out zero. That absorbs f32
    // round-off (a 0.4s frame arrives as 0.4000000059604645) and the drift in a
    // bin edge computed as b * binWidth, both of which are invisible at
    // maxDecimals anyway — a value displaying as "100.00" reads as "100".
    const shown = Number(v.toFixed(maxDecimals));
    for (let d = 0; d < maxDecimals; d++) {
      if (Number(shown.toFixed(d)) === shown) return d;
    }
    return maxDecimals;
  };
  return values.reduce((d, v) => Math.max(d, decimalsFor(v)), 0);
};

export const generateId = (): string => {
  return Math.random().toString(36).substring(2, 9);
};

export const makeAnnotationFromTool = (tool: AnnotationTool, start: number, end: number): Annotation => {
  return {
    id: generateId(),
    start,
    end,
    // The Custom tool (key '0') seeds an empty label so the user types a one-off
    // name; any other tool stamps its own label (the tool link is the label).
    text: tool.key === '0' ? '' : tool.text,
    color: tool.color,
  };
};

// Calculate vertical dodging for overlapping annotations.
// Returns new objects (inputs are never mutated) sorted by start time,
// each with a layerIndex assigned by a greedy earliest-available-layer pass.
export const calculateAnnotationLayers = (annotations: Annotation[]): AnnotationWithLayer[] => {
  const sorted = [...annotations].sort((a, b) => a.start - b.start);

  // layers[i] = end time of the most recent annotation placed in layer i.
  const layers: number[] = [];
  const result: AnnotationWithLayer[] = [];

  for (const annotation of sorted) {
    let layerIndex = layers.findIndex(end => end <= annotation.start);
    if (layerIndex === -1) {
      layerIndex = layers.length;
      layers.push(annotation.end);
    } else {
      layers[layerIndex] = annotation.end;
    }
    result.push({ ...annotation, layerIndex });
  }

  return result;
};

// Strip a trailing file extension (the last ".ext" with no slash inside it).
// Leaves paths with no extension untouched.
export function stripExt(path: string): string {
    return path.replace(/\.[^/.]+$/, "");
}

// Return the final path segment, splitting on either separator so this works on
// both POSIX ("/Users/luke/bird.mp3") and Windows ("C:\\Users\\luke\\bird.mp3")
// paths. Falls back to the whole input when there is no separator.
export function basename(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

// Fisher–Yates shuffle returning a NEW array; the input is never mutated.
export function shuffleArray<T>(arr: T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// Helper for file saving via Tauri native dialog
const saveFile = async (
    content: string,
    defaultPath: string,
    extension: string,
) => {
    const chosenPath = await saveFileDialog(defaultPath, [
        { name: 'Annotation File', extensions: [extension.replace('.', '')] },
    ]);
    if (chosenPath) {
        await writeTextFile(chosenPath, content);
    }
};

// Derives the default save path next to the source file.
// trackPath is the absolute path, e.g. "/Users/luke/audio/bird.mp3"
const defaultSavePath = (trackPath: string | null, filename: string, suffix: string, ext: string): string => {
    const base = stripExt(filename);
    const outName = `${base}${suffix}${ext}`;
    if (trackPath) {
        // Split on either separator so this works on Windows paths too
        const parts = trackPath.split(/[\\/]/);
        parts.pop();
        const dir = parts.join('/');
        return `${dir}/${outName}`;
    }
    return outName;
};

// Pure content generators (no file dialog — used by auto-save and export alike).
//
// Precision note: annotation start/end are stored in seconds as JS floats
// (IEEE 754 double, ~15 significant digits — easily sample-accurate for any
// audio sample rate and file length we care about). The default of 7 decimal
// places = 100ns covers 192 kHz with sub-sample margin (1e-7 * 192000 ≈ 0.02
// samples). This is a good balance between human-readable output and re-import
// fidelity, but is NOT a bit-exact lossless round-trip; the internal pipeline
// double precision is higher.
const roundToDecimals = (v: number, decimals: number): number => {
    const factor = Math.pow(10, decimals);
    return Math.round(v * factor) / factor;
};

// One annotation serialized at the project's output precision.
const formatAnnotationLine = (a: Annotation, decimals: number): string =>
    `${roundToDecimals(a.start, decimals).toFixed(decimals)}\t${roundToDecimals(a.end, decimals).toFixed(decimals)}\t${a.text}`;

// True when `a.raw` — the line this annotation was loaded from — still describes
// it exactly. Times are compared as parsed numbers against the values that same
// parse produced, so this is only false once the user actually moves or relabels
// the annotation.
const rawLineStillMatches = (a: Annotation): boolean => {
    if (a.raw === undefined) return false;
    const parts = a.raw.split('\t');
    if (parts.length < 3) return false;
    return parseFloat(parts[0]) === a.start
        && parseFloat(parts[1]) === a.end
        && parts.slice(2).join('\t') === a.text;
};

// Serialize annotations to Audacity TXT. Untouched records are written back
// byte-for-byte as they were read (see `Annotation.raw`) so a save only rewrites
// what changed — without this every save reformats every line at `decimals` and
// shows up in git sync as the whole file being re-added.
export const generateAudacityContent = (annotations: Annotation[], decimals: number = 7): string => {
    const lines = annotations.map(a => (rawLineStillMatches(a) ? a.raw! : formatAnnotationLine(a, decimals)));
    // Sort by start time, ties broken by line text: the same order the set-merge
    // emits (`utils/annotationMerge.ts` / `git_sync/annotate.rs`), so a merged
    // file and a locally-saved one agree and neither reorders the other.
    lines.sort((x, y) => {
        const sx = startOfLine(x);
        const sy = startOfLine(y);
        if (sx !== sy) return sx < sy ? -1 : 1;
        return x < y ? -1 : x > y ? 1 : 0;
    });
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
};

// Leading tab field as a start time; unparseable lines sort last.
const startOfLine = (line: string): number => {
    const n = parseFloat(line.split('\t')[0]);
    return Number.isFinite(n) ? n : Infinity;
};

// Parse Audacity TXT (tab-delimited: start \t end \t text) into annotations.
// Pure: matches each row's text against `tools` to recover the owning tool's
// color, falling back to white for a Custom (unmatched) label. Used by both the
// auto-load effect and annotation import so the two never diverge.
export const parseAudacityContent = (
    content: string,
    tools: AnnotationTool[],
): Annotation[] => {
    const loaded: Annotation[] = [];
    const lines = content.trim().split('\n');
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
            const start = parseFloat(parts[0]);
            const end = parseFloat(parts[1]);
            const text = parts.slice(2).join('\t');
            if (!isNaN(start) && !isNaN(end)) {
                const matchedTool = tools.find(t => t.text === text);
                loaded.push({
                    id: generateId(),
                    start,
                    end,
                    text,
                    color: matchedTool?.color ?? '#ffffff',
                    raw: line,
                });
            }
        }
    }
    return loaded;
};

export type LabelMatcher = (label: string) => boolean;

// Matches a label by exact equality. The default matcher for the mass-rename
// occurrence scan and (unless the Find Label "regex"/"partial" toggles are
// on) the find-label search.
export const exactLabelMatcher = (text: string): LabelMatcher => (label) => label === text;

// Escapes regex metacharacters so `text` can be dropped into a RegExp and
// matched literally.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Matches a label against a regular expression. Returns null (rather than
// throwing) if `pattern` isn't a valid regex, so callers can show an inline
// error instead of crashing the search. Unanchored — like `useRegex`/`partial`
// combined, a match anywhere in the label counts (`buzz\d` matches
// "foo_buzz3_bar").
const buildRegexMatcher = (pattern: string): LabelMatcher | null => {
    try {
        const re = new RegExp(pattern);
        return (label) => re.test(label);
    } catch {
        return null;
    }
};

export const regexLabelMatcher = (pattern: string): LabelMatcher | null => buildRegexMatcher(pattern);

// Matches a label if `text` occurs anywhere in it — implemented as a regex
// match on the escaped, literal text, so it shares the same unanchored
// matching path as regexLabelMatcher instead of a separate `.includes()`.
export const partialLabelMatcher = (text: string): LabelMatcher | null => buildRegexMatcher(escapeRegExp(text));

// Builds the matcher for the Find Label search from its two independent
// toggles. `regex` wins when both are on (partial's escaped-literal wrapping
// is redundant once the query is already unanchored regex). Returns null for
// an invalid regex pattern.
export const buildLabelMatcher = (query: string, opts: { useRegex: boolean; partial: boolean }): LabelMatcher | null => {
    if (opts.useRegex) return buildRegexMatcher(query);
    if (opts.partial) return partialLabelMatcher(query);
    return exactLabelMatcher(query);
};

export interface LabelLineMatch {
    start: number;
    end: number;
    label: string;
}

// Find Audacity TXT lines (tab-delimited: start \t end \t text) whose label
// satisfies `matcher`, returning each match's start/end/label (label is
// included since regex/partial matches can vary from the search query, unlike
// an exact match). Pure — shared by the mass-rename occurrence scan and the
// find-label search.
export const matchingLinesInContent = (content: string, matcher: LabelMatcher): LabelLineMatch[] => {
    const matches: LabelLineMatch[] = [];
    for (const line of content.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
            const label = parts.slice(2).join('\t');
            if (matcher(label)) {
                const start = parseFloat(parts[0]);
                const end = parseFloat(parts[1]);
                if (!isNaN(start) && !isNaN(end)) matches.push({ start, end, label });
            }
        }
    }
    return matches;
};

// Rewrite Audacity TXT lines whose label matches `oldText` exactly to
// `newText`. Pure — shared by tool rename and mass rename so the on-disk
// rewrite logic exists in one place.
export const renameLabelInContent = (
    content: string,
    oldText: string,
    newText: string,
): { updated: string; changed: boolean; count: number } => {
    let count = 0;
    const lines = content.split('\n').map(line => {
        const parts = line.split('\t');
        if (parts.length >= 3 && parts.slice(2).join('\t') === oldText) {
            count++;
            return `${parts[0]}\t${parts[1]}\t${newText}`;
        }
        return line;
    });
    return { updated: lines.join('\n'), changed: count > 0, count };
};

// Merge imported annotations onto existing ones by appending. Incoming
// annotations are given fresh ids so they never collide with existing ids.
// The result is sorted by start time for stable display. Pure — inputs are
// not mutated.
export const mergeAnnotations = (
    existing: Annotation[],
    incoming: Annotation[],
): Annotation[] => {
    const appended = incoming.map(a => ({ ...a, id: generateId() }));
    return [...existing, ...appended].sort((a, b) => a.start - b.start);
};

// Export to Audacity TXT (Tab delimited)
export const exportToAudacity = async (annotations: Annotation[], trackName: string, trackPath: string | null, decimals: number = 7) => {
    const path = defaultSavePath(trackPath, trackName, '_labels', '.txt');
    await saveFile(generateAudacityContent(annotations, decimals), path, '.txt');
};

// Walks up a filesystem path to find the first ancestor directory that actually
// exists. Used to seed the native directory-picker dialog at the nearest valid
// location when a configured path is missing.
export async function findFirstValidAncestor(path: string): Promise<string> {
  const sep = path.includes('/') ? '/' : '\\';
  let current = path;
  while (true) {
    const exists = await listDirectory(current).then(() => true).catch(() => false);
    if (exists) return current;
    const lastSep = current.lastIndexOf(sep);
    if (lastSep <= 0) return '';
    current = current.substring(0, lastSep);
  }
}

// Playback-speed slider mapping. The slider is linear in log-space so that
// halving and doubling take the same travel: slider [0,1] <-> speed
// [SPEED_MIN, SPEED_MAX], with slider 0.5 landing exactly on 1.0x.
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4.0;

export const speedToSlider = (speed: number): number => {
  const lnMin = Math.log(SPEED_MIN), lnMax = Math.log(SPEED_MAX);
  return (Math.log(speed) - lnMin) / (lnMax - lnMin);
};

export const sliderToSpeed = (slider: number): number => {
  const lnMin = Math.log(SPEED_MIN), lnMax = Math.log(SPEED_MAX);
  return Math.exp(lnMin + slider * (lnMax - lnMin));
};
