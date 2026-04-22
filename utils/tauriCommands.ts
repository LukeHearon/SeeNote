import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

// ── Types returned by Rust ────────────────────────────────────────────────────

export interface FileInfo {
  duration_secs: number;
  sample_rate: number;
  channels: number;
}

export interface SpectrogramChunkResult {
  data: number[];          // JSON-serialized Vec<u8>
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

export const getSpectrogramChunk = (
  path: string,
  startSec: number,
  durationSec: number,
  fftSize: number,
  hopSize: number,
): Promise<SpectrogramChunkResult> =>
  invoke('get_spectrogram_chunk', {
    req: {
      path,
      start_sec: startSec,
      duration_sec: durationSec,
      fft_size: fftSize,
      hop_size: hopSize,
    },
  });

export const getOverviewSpectrogram = (
  path: string,
  nColumns: number,
  fftSize: number,
): Promise<SpectrogramChunkResult> =>
  invoke('get_overview_spectrogram', {
    req: { path, n_columns: nColumns, fft_size: fftSize },
  });

export const listDirectory = (path: string): Promise<DirEntry[]> =>
  invoke('list_directory', { path });

export const writeTextFile = (path: string, content: string): Promise<void> =>
  invoke('write_text_file', { path, content });

export const readTextFile = (path: string): Promise<string | null> =>
  invoke('read_text_file', { path });

export const openFileDialog = (): Promise<string | null> =>
  invoke('open_file_dialog');

export const openDirectoryDialog = (): Promise<string | null> =>
  invoke('open_directory_dialog');

export const openDirectoryDialogAt = (startPath: string): Promise<string | null> =>
  invoke('open_directory_dialog_at', { startPath });

export interface OpenResult {
  path: string;
  is_dir: boolean;
}

export const openFileOrFolderDialog = (): Promise<OpenResult | null> =>
  invoke('open_file_or_folder_dialog');

export const listMediaFilesRecursive = (path: string): Promise<string[]> =>
  invoke('list_media_files_recursive', { path });

export const removeFile = (path: string): Promise<void> =>
  invoke('remove_file', { path });

export const checkDirExists = (path: string): Promise<boolean> =>
  invoke('check_dir_exists', { path });

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
