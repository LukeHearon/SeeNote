import { Annotation, AnnotationTool, AnnotationWithLayer } from '../types';
import { saveFileDialog, writeTextFile, listDirectory } from './tauriCommands';

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

export const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  const csStr = cs.toString().padStart(2, '0');
  const secStr = `${s}.${csStr}s`;
  if (h > 0) return `${h}h${m}m${secStr}`;
  if (m > 0) return `${m}m${secStr}`;
  return secStr;
};

export const generateId = (): string => {
  return Math.random().toString(36).substring(2, 9);
};

export const makeAnnotationFromTool = (tool: AnnotationTool, start: number, end: number): Annotation => {
  if (tool.key === null) throw new Error('Cannot create annotation from unassigned tool');
  return {
    id: generateId(),
    toolKey: tool.key,
    start,
    end,
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

export const generateAudacityContent = (annotations: Annotation[], decimals: number = 7): string => {
    let content = "";
    annotations.forEach(a => {
        content += `${roundToDecimals(a.start, decimals).toFixed(decimals)}\t${roundToDecimals(a.end, decimals).toFixed(decimals)}\t${a.text}\n`;
    });
    return content;
};

// Parse Audacity TXT (tab-delimited: start \t end \t text) into annotations.
// Pure: matches each row's text against `tools` to recover the originating
// tool's key/color, falling back to the Custom tool ('0') and white. Used by
// both the auto-load effect and annotation import so the two never diverge.
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
                    toolKey: matchedTool?.key ?? '0',
                    start,
                    end,
                    text,
                    color: matchedTool?.color ?? '#ffffff',
                });
            }
        }
    }
    return loaded;
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
