import { Annotation, AnnotationTool } from '../types';
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

// Calculate vertical dodging for overlapping annotations
export const calculateAnnotationLayers = (annotations: Annotation[]): Annotation[] => {
  // Sort by start time
  const sorted = [...annotations].sort((a, b) => a.start - b.start);
  const processed: Annotation[] = [];
  const layers: number[] = []; // Stores the end time of the last annotation in each layer

  sorted.forEach((annotation) => {
    let placed = false;
    for (let i = 0; i < layers.length; i++) {
      // Add a small buffer for visual spacing
      if (layers[i] + 0.1 <= annotation.start) {
        annotation.layerIndex = i;
        layers[i] = annotation.end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      annotation.layerIndex = layers.length;
      layers.push(annotation.end);
    }
    processed.push(annotation);
  });
  return processed;
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
        const dir = trackPath.substring(0, trackPath.lastIndexOf('/'));
        return `${dir}/${outName}`;
    }
    return outName;
};

// Pure content generators (no file dialog — used by auto-save and export alike).
//
// Precision note: annotation start/end are stored in seconds as JS floats
// (IEEE 754 double, ~15 significant digits — easily sample-accurate for any
// audio sample rate and file length we care about). The `toFixed(4)` / `(6)`
// calls below only control the *text* representation:
//   - CSV: 4 decimal places = 100µs, ~4.4 samples at 44.1kHz. Convenient for
//     spreadsheet workflows; NOT intended for sample-exact re-import.
//   - Audacity label: 6 decimal places = 1µs, < 0.05 sample at 44.1kHz —
//     effectively lossless round-trip.
// If you ever need sample-exact CSV round-trip, bump toFixed(4) to toFixed(6)
// or export frame indices alongside. Do not confuse these format choices with
// the internal precision of the pipeline.
export const generateCSVContent = (annotations: Annotation[]): string => {
    let content = "Label,Start,End\n";
    annotations.forEach(a => {
        const safeText = `"${a.text.replace(/"/g, '""')}"`;
        content += `${safeText},${a.start.toFixed(4)},${a.end.toFixed(4)}\n`;
    });
    return content;
};

export const generateAudacityContent = (annotations: Annotation[]): string => {
    let content = "";
    annotations.forEach(a => {
        content += `${a.start.toFixed(6)}\t${a.end.toFixed(6)}\t${a.text}\n`;
    });
    return content;
};

export const generateJSONContent = (annotations: Annotation[]): string =>
    JSON.stringify(annotations, null, 2);

// Export to CSV
export const exportToCSV = async (annotations: Annotation[], trackName: string, trackPath: string | null) => {
    const path = defaultSavePath(trackPath, trackName, '_annotations', '.csv');
    await saveFile(generateCSVContent(annotations), path, '.csv');
};

// Export to Audacity TXT (Tab delimited)
export const exportToAudacity = async (annotations: Annotation[], trackName: string, trackPath: string | null) => {
    const path = defaultSavePath(trackPath, trackName, '_labels', '.txt');
    await saveFile(generateAudacityContent(annotations), path, '.txt');
};

export const exportToJSON = async (annotations: Annotation[], trackName: string, trackPath: string | null) => {
    const path = defaultSavePath(trackPath, trackName, '_annotations', '.json');
    await saveFile(generateJSONContent(annotations), path, '.json');
};
