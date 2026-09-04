import { invoke, convertFileSrc, Channel } from '@tauri-apps/api/core';
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

/** Push the configured ffmpeg/ffprobe location (or `null` to clear it) to the
 *  running app, so a change in Application Settings takes effect immediately
 *  rather than on next launch. See `audio::ffmpeg_stream::set_ffmpeg_path_override`. */
export const setFfmpegPath = (path: string | null): Promise<void> =>
  invoke('set_ffmpeg_path', { path });

/** Full path of the ffmpeg binary currently in use — the configured one, or
 *  whatever the automatic search found. `null` if none was found. */
export const detectFfmpeg = (): Promise<string | null> =>
  invoke('detect_ffmpeg');

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

/** One chunk of a range response: the chunk's grid index plus its contents. */
export interface SpectrogramRangeChunk extends SpectrogramChunkResult {
  chunk_index: number;
}

/**
 * Compute a contiguous run of chunks in one backend pass, invoking `onChunk` as
 * each completes rather than waiting for the whole range.
 *
 * Chunks in a range are computed by walking a single decoder forward, which for
 * coarse tiers avoids re-scanning the container from the start of the file once
 * per chunk. `onChunk` may be called after the promise's work begins and before
 * it resolves; the promise settles when the last chunk has been sent.
 */
export const getSpectrogramChunkRange = async (
  path: string,
  firstChunkIndex: number,
  nChunks: number,
  chunkDuration: number,
  fftSize: number,
  hopSize: number,
  onChunk: (chunk: SpectrogramRangeChunk) => void,
): Promise<void> => {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => {
    // Rust prefixes each blob with a u32 grid index (build_range_message).
    const chunk_index = new DataView(message).getUint32(0, true);
    onChunk({ chunk_index, ...parseSpectrogramBuffer(message.slice(4)) });
  };
  await invoke('get_spectrogram_chunk_range', {
    req: {
      path,
      first_chunk_index: firstChunkIndex,
      n_chunks: nChunks,
      chunk_duration: chunkDuration,
      fft_size: fftSize,
      hop_size: hopSize,
    },
    onChunk: channel,
  });
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

export const checkFileExists = (path: string): Promise<boolean> =>
  invoke('check_file_exists', { path });

/** Guess a project folder name from the archive's contents — its single
 * top-level wrapping folder if it has one, else the archive's filename stem.
 * A starting point for the user-editable "Project Folder Name" field, not a
 * requirement `extractArchive` enforces. */
export const guessProjectFolderName = (archivePath: string): Promise<string> =>
  invoke('guess_project_folder_name', { archivePath });

/** Extract a .zip, .tar, or .tar.gz/.tgz archive into `{destDir}/{folderName}`,
 * stripping the archive's own top-level wrapping folder (if it has one) so
 * `folderName` becomes the project root regardless of what the archive itself
 * calls that folder. Rejects if the target folder already exists. Resolves to
 * the final extracted directory path. */
export const extractArchive = (archivePath: string, destDir: string, folderName: string): Promise<string> =>
  invoke('extract_archive', { archivePath, destDir, folderName });

/** Recursively list all non-audio/video files under path. */
export const listNonMediaFilesRecursive = (path: string): Promise<string[]> =>
  invoke('list_non_media_files_recursive', { path });

/**
 * Read `{buzzdetectDir}/{ident}_buzzdetect.csv` and parse it. Resolves to
 * `null` when no file exists for this ident. `frameLength`, when given,
 * overrides auto-detection of the bin width from the CSV's `start` column.
 * `trimActivationPrefix` (default `true`) controls whether a leading
 * `activation_` is stripped from a column's name before it's used as a
 * neuron label.
 *
 * The Rust side reports a missing cell as `null` (JSON has no NaN literal);
 * this wrapper converts those to `NaN` so the rest of the app can treat
 * `BuzzdetectData.values` as plain `number[][]` and just check `isNaN`.
 */
export const readBuzzdetect = (
  buzzdetectDir: string,
  ident: string,
  frameLength?: number,
  trimActivationPrefix?: boolean,
): Promise<BuzzdetectData | null> =>
  invoke<Omit<BuzzdetectData, 'values'> & { values: (number | null)[][] } | null>('read_buzzdetect', {
    buzzdetectDir,
    ident,
    frameLength: frameLength ?? null,
    trimActivationPrefix: trimActivationPrefix ?? true,
  }).then(data => data && { ...data, values: data.values.map(row => row.map(v => v ?? NaN)) });

export const createDirAll = (path: string): Promise<void> =>
  invoke('create_dir_all', { path });

/** Export `[startSec, startSec + durationSec)` of `sourcePath`'s audio to
 * `outPath`, preserving its channel count. `outPath`'s extension picks the
 * output format: `.wav` is always supported; anything else needs ffmpeg
 * installed (see `detectFfmpeg`) and rejects with an error otherwise. */
export const exportAudioRange = (
  sourcePath: string,
  startSec: number,
  durationSec: number,
  outPath: string,
): Promise<void> =>
  invoke('export_audio_range', { sourcePath, startSec, durationSec, outPath });

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

/** A file path handed to us at OS launch (file-association "Open With", or a
 * relaunch forwarded from a second instance) before any frontend listener was
 * attached. Drains it — a second call returns null. Pair with the `open-file`
 * event (see hooks/useOsOpenFile.ts) which covers the same cases live. */
export const takePendingOpenFile = (): Promise<string | null> =>
  invoke('take_pending_open_file');

/** Converts an absolute local path to a Tauri asset URL for use in <audio>/<video> src.
 * Delegates to Tauri's `convertFileSrc`, which emits the correct scheme and encoding
 * per platform: `asset://localhost/...` on macOS/Linux and `http://asset.localhost/...`
 * on Windows. Do NOT hand-build this string — a literal `asset://localhost` + path
 * breaks on Windows (drive-letter paths have no leading slash, use backslashes, and
 * are served under a different scheme), tripping WebView2's URL safety check. */
export const toAssetUrl = (absolutePath: string): string =>
  convertFileSrc(absolutePath);

/** Linux-only alternative to `toAssetUrl` for <video>/<audio> element `src`.
 * WebKitGTK's GStreamer media pipeline (`webkitwebsrc`, used for real
 * playback) has no bridge to Tauri's custom `asset://` scheme handler — only
 * WebKit's generic resource loader (fetch, <img>, XHR) does — so
 * `<video src="asset://...">` fails immediately there with
 * MEDIA_ERR_SRC_NOT_SUPPORTED even though the same file plays fine via
 * fetch() and decodes cleanly via GStreamer directly. This serves the file
 * over a real loopback HTTP server instead (see
 * `src-tauri/src/commands/video_server.rs`), which GStreamer's `souphttpsrc`
 * understands natively. Not needed on macOS/Windows — only call this when
 * `isLinux` (see `utils/platform.ts`). */
export const toVideoServerUrl = (absolutePath: string): Promise<string> =>
  invoke('get_video_server_url', { path: absolutePath });

// ── Auto-update ───────────────────────────────────────────────────────────────

export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
}

/** Checks the GitHub releases updater manifest. Resolves to null when already up to date. */
export const checkForUpdate = (): Promise<UpdateInfo | null> =>
  invoke('check_for_update');

/** Downloads and installs the available update, then restarts the app. Only
 * resolves on failure — success ends the process. */
export const installUpdate = (): Promise<void> =>
  invoke('install_update');

/** False on a Linux install that isn't running as an AppImage (e.g. .deb) —
 * there's no artifact the updater can swap in for those. */
export const isUpdateSupported = (): Promise<boolean> =>
  invoke('is_update_supported');

/** Opens a github.com URL (releases page, repo page, …) in the user's default browser. */
export const openGithubUrl = (url: string): Promise<void> =>
  invoke('open_github_url', { url });

// ── Diagnostics ──────────────────────────────────────────────────────────────

export interface DiagnosticInfo {
  app_version: string;
  os: string;
  arch: string;
  /** System webview version — WebView2 / WKWebView / WebKitGTK. */
  webview: string;
  /** "release" in any installed build; "debug" only under `tauri dev`. */
  build: string;
}

/** App version, OS, and build info for the top of the debug log. */
export const getDiagnosticInfo = (): Promise<DiagnosticInfo> =>
  invoke('get_diagnostic_info');

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
  samples: Float32Array;
  frames_read: number;
  /** Absolute frame index of samples[0] in the file. */
  start_frame: number;
}

/** Open a seeked PCM stream at start_sec. Returns a handle for subsequent reads. */
export const startPcmStream = (path: string, startSec: number): Promise<PcmStreamHandle> =>
  invoke('start_pcm_stream', { path, startSec });

// Header layout from Rust's build_pcm_chunk_response (12 bytes, little-endian):
//   u32 frames_read, u64 start_frame
const PCM_CHUNK_HEADER_BYTES = 12;

/**
 * Read up to maxFrames interleaved f32 frames. frames_read === 0 means EOF.
 *
 * Binary IPC (see build_pcm_chunk_response): this is called roughly once per
 * second of played audio, plus back-to-back while PcmCache primes a
 * selection, so JSON's per-call serialize/parse cost (measured ~2-4ms/call
 * server-side alone, before the ~2.3x larger payload) is worth avoiding here
 * the same way the spectrogram path already does.
 */
export const readPcmChunk = async (streamId: number, maxFrames: number): Promise<PcmChunkResult> => {
  const buffer = await invoke<ArrayBuffer>('read_pcm_chunk', { streamId, maxFrames });
  const view = new DataView(buffer);
  const frames_read = view.getUint32(0, true);
  const start_frame = view.getBigUint64(4, true);
  // Slice the tail into a new ArrayBuffer so Float32Array alignment is guaranteed.
  const samples = new Float32Array(buffer.slice(PCM_CHUNK_HEADER_BYTES));
  return { samples, frames_read, start_frame: Number(start_frame) };
};

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

// ── Git credential store ──────────────────────────────────────────────────────

/** Store a PAT for the given repo URL in the OS credential store. */
export const setGitCredential = (remoteUrl: string, token: string): Promise<void> =>
  invoke('set_git_credential', { remoteUrl, token });

/** Retrieve the stored PAT for the given repo URL, or null if absent. */
export const getGitCredential = (remoteUrl: string): Promise<string | null> =>
  invoke('get_git_credential', { remoteUrl });

/** Remove the stored PAT for the given repo URL. */
export const deleteGitCredential = (remoteUrl: string): Promise<void> =>
  invoke('delete_git_credential', { remoteUrl });

// ── Git sync ────────────────────────────────────────────────────────────────

/** Result of a sync, for the non-blocking post-sync summary. */
export interface SyncSummary {
  pulled: boolean;
  pushed: boolean;
  annotationsAdded: number;
  annotationsRemoved: number;
  recordingsChanged: string[];
  annotationsUploaded: number;
  annotationsRemovedOnPush: number;
  identsUploaded: number;
  /**
   * Idents whose annotation file is now empty while history still holds records
   * for them — i.e. tracks the user appears to have cleared. These are NOT
   * committed: emptying a track destroys records for everyone, so the UI lists
   * them and asks. Confirming re-runs the sync with them as `confirmedClears`.
   */
  pendingClears: string[];
  message: string;
}

/** Local-only sync state (no network call). */
export interface SyncStatus {
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
}

/**
 * Sync annotation data to/from the project's configured GitHub repo using
 * embedded libgit2: stage annotations, commit, fetch, merge (semantic
 * set-merge for annotation files), and push. Media, tool example clips, and
 * settings.json are never tracked. `token` must be fetched from the OS
 * credential store via `getGitCredential` before calling this. See
 * src-tauri/src/commands/git_sync.rs. `annotationDir` must be inside
 * `projectDir` (the repo root).
 */
export const syncProject = (
  projectDir: string,
  annotationDir: string,
  remoteUrl: string,
  token: string,
  authorName: string,
  // Optional custom commit message; empty string uses the default ("Update annotations").
  commitMessage = '',
  // Idents from a previous run's `pendingClears` that the user has confirmed
  // clearing. Empty on a first attempt.
  confirmedClears: string[] = [],
): Promise<SyncSummary> =>
  invoke('sync_project', { projectDir, annotationDir, remoteUrl, token, authorName, commitMessage, confirmedClears });

/**
 * Pull remote annotation changes in without pushing local commits: stages and
 * commits local changes (so the merge's checkout can't clobber them), fetches,
 * and merges — but never pushes. Used for the background auto-pull; pushing
 * stays an explicit "Sync" action via `syncProject`.
 */
export const pullProject = (
  projectDir: string,
  annotationDir: string,
  remoteUrl: string,
  token: string,
  authorName: string,
): Promise<SyncSummary> =>
  invoke('pull_project', { projectDir, annotationDir, remoteUrl, token, authorName });

/** Check local-only sync state (no network). */
export const getLocalSyncStatus = (
  projectDir: string,
  annotationDir: string,
): Promise<SyncStatus> =>
  invoke('get_local_sync_status', { projectDir, annotationDir });

/** Fetch the remote branch and return whether it's ahead of HEAD (network call). */
export const fetchRemoteStatus = (
  projectDir: string,
  remoteUrl: string,
  token: string,
): Promise<boolean> =>
  invoke('fetch_remote_status', { projectDir, remoteUrl, token });

/** Open the copy editor in a separate native window. */
export function openCopyEditorWindow(): void {
  invoke('open_copy_editor_window').catch(console.error);
}

/** Open (or focus) the help guide in a separate native window, optionally on a
 *  specific page. Navigating an already-open window is handled frontend-side
 *  over the help channel — see utils/helpChannel.ts. */
export function openHelpWindow(page?: string): void {
  invoke('open_help_window', { page: page ?? null }).catch(console.error);
}

/** Close the help guide window (called from inside the window itself). */
export function closeHelpWindow(): void {
  invoke('close_help_window').catch(console.error);
}

/** Open the sync setup guide in a separate native window. */
export function openSyncGuideWindow(): void {
  invoke('open_sync_guide_window').catch(console.error);
}

/** Close the sync guide window (called from inside the window itself). */
export function closeSyncGuideWindow(): void {
  invoke('close_sync_guide_window').catch(console.error);
}

export async function saveCopyOverrides(overrides: Record<string, string>): Promise<string> {
  return invoke<string>('save_copy_overrides', { overridesJson: JSON.stringify(overrides, null, 2) });
}

export async function applyCopyOverrides(overrides: Record<string, string>): Promise<string> {
  return invoke<string>('apply_copy_overrides', { overridesJson: JSON.stringify(overrides, null, 2) });
}
