import { useCallback } from 'react';
import type { Selection } from '../types';
import { basename } from '../utils/helpers';
import { suggestExportFilename, audioExportExtensions } from '../utils/filenameTime';
import { saveFileDialog, exportAudioRange } from '../utils/tauriCommands';

interface ExportSelectionParams {
  selection: Selection | null;
  trackPath: string | null;
  selectionToSource: (s: Selection) => Selection;
  /** The project's filename-timestamp scheme, when there is one. */
  filenameTimeFormat?: string;
  filenameTimeOffsetSeparator?: string;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * Export the current selection's audio to a file (the spectrogram's context
 * menu and Mod+Shift+E). The selection is display time; the file is read at its
 * source time, which under a subset is not the same thing. With a filename-time
 * scheme the suggested name follows it, so exports keep the tracks' naming
 * convention; without one it falls back to an "_s<offset>" suffix.
 */
export function useExportSelection({
  selection, trackPath, selectionToSource, filenameTimeFormat, filenameTimeOffsetSeparator, addLog,
}: ExportSelectionParams) {
  return useCallback(async () => {
    if (!selection || !trackPath) return;
    const src = selectionToSource(selection);
    const filename = basename(trackPath);
    const dir = trackPath.slice(0, trackPath.length - filename.length);
    const suggested = suggestExportFilename(filename, src.start, filenameTimeFormat, filenameTimeOffsetSeparator);
    const chosenPath = await saveFileDialog(`${dir}${suggested}`, [
      { name: 'Audio File', extensions: audioExportExtensions(filename) },
    ]);
    if (!chosenPath) return;
    try {
      await exportAudioRange(trackPath, src.start, src.end - src.start, chosenPath);
      addLog(`Exported selection to ${basename(chosenPath)}`);
    } catch (err) {
      addLog(`Error exporting audio: ${err}`, 'error');
    }
  }, [selection, trackPath, selectionToSource, filenameTimeFormat, filenameTimeOffsetSeparator, addLog]);
}
