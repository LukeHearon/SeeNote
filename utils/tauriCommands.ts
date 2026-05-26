import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { BuzzdetectData } from '../types';

// ── Types returned by Rust ────────────────────────────────────────────────────

export interface FileInfo {
  duration_secs: number;
  sample_rate: number;
  channels: number;
}

export interface SpectrogramChunkResult {
  data: Uint16Array;       // Binary IPC: u16 per cell, -140..0 dBFS mapped to 0..65535
  n_cols: number;
  n_freq_bins: number;
  start_sec: number;
  actual_duration_sec: number;
  sample_rate: number;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_audio: boolean;
  is_video: boolean;
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

// ── Commands ──────────────────────────────────────────────────────────────────

export const getFileInfo = (path: string): Promise<FileInfo> =>
  invoke('get_file_info', { path });

// Header layout from Rust's build_spectrogram_response (28 bytes, all little-endian):
//   u32 n_cols, u32 n_freq_bins, f64 start_sec, f64 actual_duration_sec, u32 sample_rate
const SPECTROGRAM_HEADER_BYTES = 28;

function parseSpectrogramBuffer(buffer: ArrayBuffer): SpectrogramChunkResult {
  const view = new DataView(buffer);
  const n_cols = view.getUint32(0, true);
  const n_freq_bins = view.getUint32(4, true);
  const start_sec = view.getFloat64(8, true);
  const actual_duration_sec = view.getFloat64(16, true);
  const sample_rate = view.getUint32(24, true);
  // Slice the tail into a new ArrayBuffer so Uint16Array alignment is guaranteed.
  const data = new Uint16Array(buffer.slice(SPECTROGRAM_HEADER_BYTES));
  return { data, n_cols, n_freq_bins, start_sec, actual_duration_sec, sample_rate };
}

export const getSpectrogramChunk = async (
  path: string,
  startSec: number,
  durationSec: number,
  fftSize: number,
  hopSize: number,
): Promise<SpectrogramChunkResult> => {
  const buffer = await invoke<ArrayBuffer>('get_spectrogram_chunk', {
    req: {
      path,
      start_sec: startSec,
      duration_sec: durationSec,
      fft_size: fftSize,
      hop_size: hopSize,
    },
  });
  return parseSpectrogramBuffer(buffer);
};

export const getOverviewSpectrogram = async (
  path: string,
  nColumns: number,
  fftSize: number,
): Promise<SpectrogramChunkResult> => {
  const buffer = await invoke<ArrayBuffer>('get_overview_spectrogram', {
    req: { path, n_columns: nColumns, fft_size: fftSize },
  });
  return parseSpectrogramBuffer(buffer);
};

export const listDirectory = (path: string): Promise<DirEntry[]> =>
  invoke('list_directory', { path });

export const writeTextFile = (path: string, content: string): Promise<void> =>
  invoke('write_text_file', { path, content });

export const readTextFile = (path: string): Promise<string | null> =>
  invoke('read_text_file', { path });

export const openDirectoryDialog = (): Promise<string | null> =>
  invoke('open_directory_dialog');

export const openDirectoryDialogAt = (startPath: string): Promise<string | null> =>
  invoke('open_directory_dialog_at', { startPath });


export const listMediaFilesRecursive = (path: string): Promise<string[]> =>
  invoke('list_media_files_recursive', { path });

/** Recursively list annotation files with the given extension (e.g. '.txt', '.csv', '.json'). Returns absolute paths. */
export const listAnnotationFilesRecursive = (dir: string, ext: string): Promise<string[]> =>
  invoke('list_txt_files_recursive', { path: dir, ext });

export const removeFile = (path: string): Promise<void> =>
  invoke('remove_file', { path });

export const checkDirExists = (path: string): Promise<boolean> =>
  invoke('check_dir_exists', { path });

/**
 * Read `{buzzdetectDir}/{ident}_buzzdetect.csv` and parse it. Resolves to
 * `null` when no file exists for this ident.
 */
export const readBuzzdetect = (
  buzzdetectDir: string,
  ident: string,
): Promise<BuzzdetectData | null> =>
  invoke('read_buzzdetect', { buzzdetectDir, ident });

export const createDirAll = (path: string): Promise<void> =>
  invoke('create_dir_all', { path });

export const saveFileDialog = (
  defaultPath: string,
  filters: DialogFilter[],
): Promise<string | null> =>
  invoke('save_file_dialog', { defaultPath, filters });

/** Converts an absolute local path to a Tauri asset URL for use in <audio>/<video> src. */
export const toAssetUrl = (absolutePath: string): string =>
  convertFileSrc(absolutePath);

// ── PCM streaming ─────────────────────────────────────────────────────────────

export interface PcmStreamHandle {
  stream_id: number;
  sample_rate: number;
  channels: number;
  /** Total frames in the file (duration_secs * sample_rate). */
  total_frames: number;
}

export interface PcmChunkResult {
  /** Interleaved f32 samples. length === frames_read * channels. */
  samples: number[];
  frames_read: number;
  /** Absolute frame index of samples[0] in the file. */
  start_frame: number;
}

/** Open a seeked PCM stream at start_sec. Returns a handle for subsequent reads. */
export const startPcmStream = (path: string, startSec: number): Promise<PcmStreamHandle> =>
  invoke('start_pcm_stream', { path, startSec });

/** Read up to maxFrames interleaved f32 frames. frames_read === 0 means EOF. */
export const readPcmChunk = (streamId: number, maxFrames: number): Promise<PcmChunkResult> =>
  invoke('read_pcm_chunk', { streamId, maxFrames });

/** Close and discard the stream. */
export const closePcmStream = (streamId: number): Promise<void> =>
  invoke('close_pcm_stream', { streamId });

// ── Window bounds ─────────────────────────────────────────────────────────────

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const getWindowBounds = (): Promise<WindowBounds> =>
  invoke('get_window_bounds');

export const setWindowBounds = (bounds: WindowBounds): Promise<void> =>
  invoke('set_window_bounds', { bounds });
