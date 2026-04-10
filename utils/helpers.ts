import { Label } from '../types';
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

// Calculate vertical dodging for overlapping labels
export const calculateLabelLayers = (labels: Label[]): Label[] => {
  // Sort by start time
  const sorted = [...labels].sort((a, b) => a.start - b.start);
  const processed: Label[] = [];
  const layers: number[] = []; // Stores the end time of the last label in each layer

  sorted.forEach((label) => {
    let placed = false;
    for (let i = 0; i < layers.length; i++) {
      // Add a small buffer for visual spacing
      if (layers[i] + 0.1 <= label.start) {
        label.layerIndex = i;
        layers[i] = label.end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      label.layerIndex = layers.length;
      layers.push(label.end);
    }
    processed.push(label);
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
// currentFilePath is the absolute path, e.g. "/Users/luke/audio/bird.mp3"
const defaultSavePath = (currentFilePath: string | null, filename: string, suffix: string, ext: string): string => {
    const base = getBaseName(filename);
    const outName = `${base}${suffix}${ext}`;
    if (currentFilePath) {
        const dir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
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
export const generateCSVContent = (labels: Label[]): string => {
    let content = "Label,Start,End\n";
    labels.forEach(l => {
        const safeText = `"${l.text.replace(/"/g, '""')}"`;
        content += `${safeText},${l.start.toFixed(4)},${l.end.toFixed(4)}\n`;
    });
    return content;
};

export const generateAudacityContent = (labels: Label[]): string => {
    let content = "";
    labels.forEach(l => {
        content += `${l.start.toFixed(6)}\t${l.end.toFixed(6)}\t${l.text}\n`;
    });
    return content;
};

export const generateJSONContent = (labels: Label[]): string =>
    JSON.stringify(labels, null, 2);

// Export to CSV
export const exportToCSV = async (labels: Label[], filename: string, currentFilePath: string | null) => {
    const path = defaultSavePath(currentFilePath, filename, '_annotations', '.csv');
    await saveFile(generateCSVContent(labels), path, '.csv');
};

// Export to Audacity TXT (Tab delimited)
export const exportToAudacity = async (labels: Label[], filename: string, currentFilePath: string | null) => {
    const path = defaultSavePath(currentFilePath, filename, '_labels', '.txt');
    await saveFile(generateAudacityContent(labels), path, '.txt');
};

export const exportToJSON = async (labels: Label[], filename: string, currentFilePath: string | null) => {
    const path = defaultSavePath(currentFilePath, filename, '_annotations', '.json');
    await saveFile(generateJSONContent(labels), path, '.json');
};
