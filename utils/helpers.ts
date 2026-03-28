import { Label } from '../types';
import { saveFileDialog, writeTextFile } from './tauriCommands';

export const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
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

// Export to CSV
export const exportToCSV = async (labels: Label[], filename: string, currentFilePath: string | null) => {
    const path = defaultSavePath(currentFilePath, filename, '_annotations', '.csv');

    let csvContent = "Label,Start,End\n";
    labels.forEach(l => {
        const safeText = `"${l.text.replace(/"/g, '""')}"`;
        csvContent += `${safeText},${l.start.toFixed(4)},${l.end.toFixed(4)}\n`;
    });

    await saveFile(csvContent, path, '.csv');
};

// Export to Audacity TXT (Tab delimited)
export const exportToAudacity = async (labels: Label[], filename: string, currentFilePath: string | null) => {
    const path = defaultSavePath(currentFilePath, filename, '_labels', '.txt');

    let txtContent = "";
    labels.forEach(l => {
        txtContent += `${l.start.toFixed(6)}\t${l.end.toFixed(6)}\t${l.text}\n`;
    });

    await saveFile(txtContent, path, '.txt');
};

export const exportToJSON = async (labels: Label[], filename: string, currentFilePath: string | null) => {
    const path = defaultSavePath(currentFilePath, filename, '_annotations', '.json');
    const jsonContent = JSON.stringify(labels, null, 2);
    await saveFile(jsonContent, path, '.json');
};
