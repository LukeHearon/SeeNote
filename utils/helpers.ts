import { Annotation, AnnotationTool, AnnotationWithLayer } from '../types';
import { saveFileDialog, writeTextFile } from './tauriCommands';

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

export const makeAnnotationFromTool = (tool: AnnotationTool, start: number, end: number): Annotation => ({
  id: generateId(),
  toolKey: tool.key,
  start,
  end,
  text: tool.key === '0' ? '' : tool.text,
  color: tool.color,
});

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

const getBaseName = (filename: string) => {
    return filename.replace(/\.[^/.]+$/, "");
};

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
    const base = getBaseName(filename);
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

export const generateCSVContent = (annotations: Annotation[], decimals: number = 7): string => {
    let content = "Label,Start,End\n";
    annotations.forEach(a => {
        const safeText = `"${a.text.replace(/"/g, '""')}"`;
        content += `${safeText},${roundToDecimals(a.start, decimals).toFixed(decimals)},${roundToDecimals(a.end, decimals).toFixed(decimals)}\n`;
    });
    return content;
};

export const generateAudacityContent = (annotations: Annotation[], decimals: number = 7): string => {
    let content = "";
    annotations.forEach(a => {
        content += `${roundToDecimals(a.start, decimals).toFixed(decimals)}\t${roundToDecimals(a.end, decimals).toFixed(decimals)}\t${a.text}\n`;
    });
    return content;
};

export const generateJSONContent = (annotations: Annotation[], decimals: number = 7): string => {
    const rounded = annotations.map(a => ({
        ...a,
        start: roundToDecimals(a.start, decimals),
        end: roundToDecimals(a.end, decimals),
    }));
    return JSON.stringify(rounded, null, 2);
};

// Export to CSV
export const exportToCSV = async (annotations: Annotation[], trackName: string, trackPath: string | null, decimals: number = 7) => {
    const path = defaultSavePath(trackPath, trackName, '_annotations', '.csv');
    await saveFile(generateCSVContent(annotations, decimals), path, '.csv');
};

// Export to Audacity TXT (Tab delimited)
export const exportToAudacity = async (annotations: Annotation[], trackName: string, trackPath: string | null, decimals: number = 7) => {
    const path = defaultSavePath(trackPath, trackName, '_labels', '.txt');
    await saveFile(generateAudacityContent(annotations, decimals), path, '.txt');
};

export const exportToJSON = async (annotations: Annotation[], trackName: string, trackPath: string | null, decimals: number = 7) => {
    const path = defaultSavePath(trackPath, trackName, '_annotations', '.json');
    await saveFile(generateJSONContent(annotations, decimals), path, '.json');
};
