import { invoke } from '@tauri-apps/api/core';
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

/** Peak absolute sample amplitude (mono mixdown), in [0, 1] for float PCM. */
export const audioPeak = (path: string): Promise<number> =>
  invoke('audio_peak', { path });

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

/** Open a native single-file picker. `startPath` seeds the dialog directory
 * (a file path uses its parent dir). Resolves to the chosen absolute path, or
 * null if the user cancelled. */
export const openFileDialog = (
  startPath: string | null,
  filters: DialogFilter[],
): Promise<string | null> =>
  invoke('open_file_dialog', { startPath, filters });

/** Multi-select variant of `openFileDialog`. Resolves to the chosen absolute
 * paths, or null if the user cancelled. */
export const openFilesDialog = (
  startPath: string | null,
  filters: DialogFilter[],
): Promise<string[] | null> =>
  invoke('open_files_dialog', { startPath, filters });

/** Converts an absolute local path to a Tauri asset URL for use in <audio>/<video> src.
 * Tauri's WKURLSchemeHandler uses the URL path as a literal filesystem path with no
 * percent-decoding, so we must not encode the path at all. */
export const toAssetUrl = (absolutePath: string): string =>
  `asset://localhost${absolutePath}`;

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

// ── Annotation tools (folder model) ───────────────────────────────────────────
// Tools live as folders under {projectDir}/.seenote/annotation-tools/. The folder
// NAME is the label — the exact text written into annotation .txt files — so it
// is the durable identity (no UUID). color → tool.json, description →
// description.txt, audio in examples/ → example clips. Hotkeys are project-level
// and live in settings.json, not here. See commands/annotation_tools.rs.

/** A tool as returned by the Rust folder scan. `name` is the label. */
export interface FolderTool {
  name: string;
  color: string;
  description: string;
  /** Absolute paths to example audio clips, sorted. */
  example_files: string[];
}

/** Scan the tools folder. Empty if no tools have been created yet. */
export const listAnnotationTools = (projectDir: string): Promise<FolderTool[]> =>
  invoke('list_annotation_tools', { projectDir });

/** Example clip paths for one tool, sorted. */
export const listToolExamples = (projectDir: string, name: string): Promise<string[]> =>
  invoke('list_tool_examples', { projectDir, name });

/** Create a tool folder + tool.json (+ description.txt). Rejects a duplicate label. */
export const createAnnotationTool = (
  projectDir: string,
  name: string,
  color: string,
  description: string,
): Promise<void> =>
  invoke('create_annotation_tool', { projectDir, name, color, description });

/** Rewrite a tool's color/description (not its label). */
export const updateAnnotationTool = (
  projectDir: string,
  name: string,
  color: string,
  description: string,
): Promise<void> =>
  invoke('update_annotation_tool', { projectDir, name, color, description });

/** Rename a tool's folder. Caller rewrites matching label text in annotations. */
export const renameAnnotationTool = (
  projectDir: string,
  oldName: string,
  newName: string,
): Promise<void> =>
  invoke('rename_annotation_tool', { projectDir, oldName, newName });

/** Delete a tool folder and its example clips. Annotation files untouched. */
export const deleteAnnotationTool = (projectDir: string, name: string): Promise<void> =>
  invoke('delete_annotation_tool', { projectDir, name });

export interface ImportExamplesSummary {
  tools_created: string[];
  files_copied: number;
  files_skipped: number;
}

/**
 * Import a directory of fully fleshed-out tool folders (same layout as
 * .seenote/annotation-tools/: {label}/tool.json + description.txt + examples/).
 * New labels are copied in (palette-colored when tool.json is absent);
 * existing labels keep their color/description and only merge example clips.
 * Idempotent: existing destination filenames are skipped.
 */
export const importAnnotationTools = (
  projectDir: string,
  toolsDir: string,
  palette: string[],
): Promise<ImportExamplesSummary> =>
  invoke('import_annotation_tools', { projectDir, toolsDir, palette });

/**
 * Import a directory of plain example clips (one subfolder per label, each
 * holding audio files directly). Files are copied into each tool's examples/;
 * tools are created for unknown labels, colored by cycling `palette`.
 * Idempotent: existing destination filenames are skipped.
 */
export const importToolExamples = (
  projectDir: string,
  examplesDir: string,
  palette: string[],
): Promise<ImportExamplesSummary> =>
  invoke('import_tool_examples', { projectDir, examplesDir, palette });

/**
 * Import example clips into a single tool from an explicit selection. Each path
 * may be an audio file or a directory (searched recursively); clips land flat
 * in {tool}/examples/. Existing destination filenames are skipped. The tool
 * folder is created bare if it doesn't exist yet.
 */
export const importExamplesToTool = (
  projectDir: string,
  name: string,
  paths: string[],
): Promise<ImportExamplesSummary> =>
  invoke('import_examples_to_tool', { projectDir, name, paths });
