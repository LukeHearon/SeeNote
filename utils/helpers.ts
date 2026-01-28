import { Label } from '../types';

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

// Helper for file saving logic
const saveFile = async (content: string, suggestedName: string, mimeType: string, extension: string) => {
    try {
        // @ts-ignore
        if (window.showSaveFilePicker) {
            // @ts-ignore
            const handle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'Annotation File',
                    accept: { [mimeType]: [extension] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(content);
            await writable.close();
            return;
        }
    } catch (err) {
        console.warn("File System Access API failed or cancelled, falling back to download link.", err);
    }

    // Fallback
    const encodedUri = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", suggestedName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// Export to CSV
export const exportToCSV = async (labels: Label[], filename: string) => {
    const base = getBaseName(filename);
    const outName = `${base}_annotations.csv`;
    
    // Header: Label, Start, End
    let csvContent = "Label,Start,End\n";
    labels.forEach(l => {
        // Escape quotes
        const safeText = `"${l.text.replace(/"/g, '""')}"`;
        csvContent += `${safeText},${l.start.toFixed(4)},${l.end.toFixed(4)}\n`;
    });
    
    await saveFile(csvContent, outName, 'text/csv', '.csv');
};

// Export to Audacity TXT (Tab delimited)
export const exportToAudacity = async (labels: Label[], filename: string) => {
    const base = getBaseName(filename);
    const outName = `${base}_labels.txt`;

    // No header. Start \t End \t Label
    let txtContent = "";
    labels.forEach(l => {
        txtContent += `${l.start.toFixed(6)}\t${l.end.toFixed(6)}\t${l.text}\n`;
    });
    
    await saveFile(txtContent, outName, 'text/plain', '.txt');
};

export const exportToJSON = async (labels: Label[], filename: string) => {
    const base = getBaseName(filename);
    const outName = `${base}_annotations.json`;
    
    const jsonContent = JSON.stringify(labels, null, 2);
    await saveFile(jsonContent, outName, 'application/json', '.json');
};
