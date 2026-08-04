use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use crate::audio::{decoder, fft, stream_pool};
use tauri::ipc::{Channel, InvokeResponseBody};

// ── PCM stream state ──────────────────────────────────────────────────────────

/// How long a stream may be idle before it is reaped on the next registry
/// access. 60 seconds covers any reasonable frontend stall or reconnect.
const STREAM_TTL: Duration = Duration::from_secs(60);

/// Per-stream registry entry. Each stream has its own `Mutex` so concurrent
/// reads on *different* streams run in parallel without contending on the
/// global `streams` map lock.
pub(crate) struct StreamEntry {
    /// The actual stream, independently locked so reads on different streams
    /// don't serialize against each other (fixing the race from the old design
    /// where the global `streams` MutexGuard was held for the full read).
    stream: Arc<Mutex<decoder::PcmStream>>,
    /// Wall-clock time of the last `read_pcm_chunk` call. Updated under the
    /// global `streams` lock; used to evict idle entries (Finding 4 TTL).
    last_used: Instant,
}

/// Managed Tauri state for open PCM streams.
pub struct PcmStreamState {
    pub(crate) streams: Mutex<HashMap<u64, StreamEntry>>,
    pub next_id: AtomicU64,
}

impl Default for PcmStreamState {
    fn default() -> Self {
        PcmStreamState {
            streams: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }
}

/// Evict registry entries that have been idle longer than `STREAM_TTL`.
/// Must be called with `streams` already locked (the caller passes the guard).
fn reap_idle_streams(streams: &mut HashMap<u64, StreamEntry>) {
    let now = Instant::now();
    streams.retain(|id, entry| {
        let keep = now.duration_since(entry.last_used) < STREAM_TTL;
        if !keep {
            eprintln!("PcmStream {id}: evicted after idle TTL ({STREAM_TTL:?})");
        }
        keep
    });
}

// ── File info ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct FileInfoResult {
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

#[tauri::command]
pub async fn get_file_info(path: String) -> Result<FileInfoResult, String> {
    decoder::get_file_info(&path)
        .map(|i| FileInfoResult {
            duration_secs: i.duration_secs,
            sample_rate: i.sample_rate,
            channels: i.channels,
        })
        .map_err(|e| e.to_string())
}

/// Set (or clear, with `null`) the custom ffmpeg/ffprobe location used as a
/// fallback decode backend for `.wma` (see `audio::ffmpeg_stream`). Called
/// once at startup with the Application Settings value, and again whenever
/// the user edits it, so a running app picks up the change immediately.
#[tauri::command]
pub async fn set_ffmpeg_path(path: Option<String>) -> Result<(), String> {
    crate::audio::ffmpeg_stream::set_ffmpeg_path_override(path);
    Ok(())
}

// ── Peak amplitude (for loudness normalization) ────────────────────────────────

/// Peak absolute sample amplitude of the whole file, on the mono mixdown (the
/// same averaged-across-channels signal the playback path produces). Returned
/// in [0, 1] for normal float PCM. Used by the example-clip player to compute a
/// normalization gain so quiet and loud clips preview at a comparable level.
///
/// Decodes the entire file; intended for the short example clips, not full
/// recordings.
#[tauri::command]
pub async fn audio_peak(path: String) -> Result<f32, String> {
    let info = decoder::get_file_info(&path).map_err(|e| e.to_string())?;
    let dur = info.duration_secs.max(0.0);
    let (samples, _sr) =
        decoder::decode_audio_range(&path, 0.0, dur).map_err(|e| e.to_string())?;
    let peak = samples.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    Ok(peak)
}

// ── Spectrogram chunk ─────────────────────────────────────────────────────────

/// Seek margin for the coarse column walk (see PcmStream::seek_to).
///
/// The margin is decoded and thrown away at every column, so at the default
/// 0.5s each column decoded far more audio than it keeps — on the hottest path
/// for long files. 50ms still comfortably covers a container seek landing late
/// (an MP3 packet is ~26ms).
const COARSE_SEEK_MARGIN_SEC: f64 = 0.05;

#[derive(Deserialize)]
pub struct SpectrogramChunkRequest {
    pub path: String,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub fft_size: usize,
    pub hop_size: usize,
}

/// Encode spectrogram metadata + u16 data into a binary blob for IPC.
///
/// Header layout (28 bytes, all little-endian):
///   u32  n_cols
///   u32  n_freq_bins
///   f64  start_sec
///   f64  actual_duration_sec
///   u32  sample_rate
/// Followed by n_cols * n_freq_bins u16 values (little-endian).
fn build_spectrogram_response(
    n_cols: usize,
    n_freq_bins: usize,
    start_sec: f64,
    actual_duration_sec: f64,
    sample_rate: u32,
    data: &[u16],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(28 + data.len() * 2);
    bytes.extend_from_slice(&(n_cols as u32).to_le_bytes());
    bytes.extend_from_slice(&(n_freq_bins as u32).to_le_bytes());
    bytes.extend_from_slice(&start_sec.to_le_bytes());
    bytes.extend_from_slice(&actual_duration_sec.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    for &v in data {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// True when a tier's hop is coarse enough that sampling beats decoding through.
///
/// Below this the chunk's whole span is decoded sequentially anyway, so the
/// sampled path's per-column seek would cost more than it saves.
fn is_coarse_hop(hop_size: usize, sample_rate: u32) -> bool {
    hop_size >= (sample_rate as usize) / 2
}

/// Column count and reported extent for a coarse chunk starting at `start_sec`.
///
/// Same invariant as the standard STFT path: n_cols / actual_duration_sec must
/// equal the true cps (= sample_rate / hop_size) so the renderer places columns
/// at their real centres. Since n_cols is integer-truncated, the only way to
/// keep the ratio exact is to derive the duration back from n_cols.
fn coarse_geometry(
    start_sec: f64,
    duration_sec: f64,
    file_duration_sec: f64,
    hop_size: usize,
    sample_rate: u32,
) -> (usize, f64) {
    let actual_end = (start_sec + duration_sec).min(file_duration_sec);
    let span = (actual_end - start_sec).max(0.0);
    let n_cols = ((span * sample_rate as f64) / hop_size as f64).floor() as usize + 1;
    (n_cols, n_cols as f64 * hop_size as f64 / sample_rate as f64)
}

/// Fill `output` with `n_cols` coarse spectrogram columns starting at
/// `start_sec`, walking `stream` FORWARD. `seek_first` seeks before the first
/// column; pass false when the stream is already positioned there (a fresh
/// open), true when continuing from a previous chunk.
///
/// ── Why seek instead of read-through ────────────────────────────────────────
/// This path used to advance between columns by *reading and discarding* the
/// hop, which meant fully decoding the chunk's entire span to emit a handful of
/// columns — for the coarsest tier of a 50h file, decoding the whole file.
/// Measured on a 1GB / 49.7h MP3 (see decoder::seek_bench):
///
///   sequential decode of the whole file    ~48 s
///   100 forward seek_to calls across it    ~0.28 s total
///
/// Forward seeks on a reused stream resume the container scan from the current
/// position, so a column walk costs roughly ONE pass over the frame headers no
/// matter how many columns it emits — the totals for 20 and 100 columns were
/// within 15% of each other. Only backward seeks and re-opens restart the scan
/// from byte 0 (~122 ms each at depth), which a monotonically forward walk never
/// does. The gap widens on slow disks, since scanning touches a small fraction
/// of the bytes decoding would. Taking `stream` by reference is what lets
/// `compute_spectrogram_range` extend one walk across many chunks.
///
/// ── Why exactly one window per column ───────────────────────────────────────
/// Each column is a single fft_size window sampled at the column's centre —
/// the same estimator the fine tiers use, so a coarse view has the same
/// contrast and noise texture as a zoomed-in one, just sampled more sparsely.
///
/// This previously pooled ~0.3s per column and kept the per-bin MAXIMUM across
/// the windows in it, to catch transients falling between columns. The max of
/// several noisy spectra estimates their upper envelope rather than their
/// level, so it lifted the noise floor by several dB and washed out the whole
/// image — coarse views looked horizontally smeared next to fine ones. The
/// sparse sampling it was compensating for is an accepted trade-off.
#[allow(clippy::too_many_arguments)]
fn coarse_columns(
    stream: &mut decoder::PcmStream,
    output: &mut [u16],
    n_cols: usize,
    n_freq_bins: usize,
    start_sec: f64,
    hop_size: usize,
    fft_size: usize,
    sample_rate: u32,
    seek_first: bool,
) {
    let ch = stream.channels().max(1) as usize;
    // Audio each column summarizes: exactly one FFT window.
    let pool_frames = fft_size;
    let mut mono = vec![0.0f32; pool_frames];

    for col in 0..n_cols {
        // Column k is centred at start_sec + k*hop/sample_rate.
        if col > 0 || seek_first {
            let t = start_sec + (col * hop_size) as f64 / sample_rate as f64;
            if stream.seek_to(t, COARSE_SEEK_MARGIN_SEC).is_err() {
                break; // past EOF or unreadable — remaining columns stay 0
            }
        }

        // Read this column's span, mixing down to mono.
        let mut filled = 0usize;
        while filled < pool_frames {
            let (interleaved, frames_read) = match stream.read(pool_frames - filled) {
                Ok(r) => r,
                Err(_) => break,
            };
            if frames_read == 0 {
                break; // EOF — partial span; the guard below handles it
            }
            for frame in 0..frames_read {
                let mut sum = 0.0f32;
                for c in 0..ch {
                    sum += interleaved[frame * ch + c];
                }
                mono[filled + frame] = sum / ch as f32;
            }
            filled += frames_read;
        }

        // A column needs a full window; a shorter tail stays 0.
        if filled < fft_size {
            continue;
        }

        let window = fft::compute_stft(&mono[..fft_size], fft_size, fft_size);
        let dst = &mut output[col * n_freq_bins..(col + 1) * n_freq_bins];
        dst.copy_from_slice(&window[..n_freq_bins]);
    }
}

/// Decode + STFT one chunk, returning the encoded IPC blob.
///
/// Deliberately synchronous: it is pure CPU work (decode, FFT) with no await
/// points, and it runs on a blocking thread — see `get_spectrogram_chunk_range`,
/// the single command that reaches it.
fn compute_spectrogram_chunk(req: &SpectrogramChunkRequest) -> Result<Vec<u8>, String> {
    let info = decoder::get_file_info(&req.path).map_err(|e| e.to_string())?;
    let sample_rate = info.sample_rate;
    let n_freq_bins = req.fft_size / 2;

    // For very large hop sizes (coarse overview tiers), use a sampled approach:
    // seek to each column position and pool a short span there instead of
    // decoding the entire range and running a full STFT. See coarse_columns.
    if is_coarse_hop(req.hop_size, sample_rate) {
        let (n_cols, actual_duration_sec) =
            coarse_geometry(req.start_sec, req.duration_sec, info.duration_secs, req.hop_size, sample_rate);
        let mut output = vec![0u16; n_cols * n_freq_bins];

        // A pooled stream skips the container re-scan when one is already
        // positioned before this chunk (see audio::stream_pool). acquire() has
        // seeked it to start_sec, so the walk does not seek again for column 0.
        if let Ok(mut stream) = stream_pool::acquire(&req.path, req.start_sec, COARSE_SEEK_MARGIN_SEC) {
            coarse_columns(
                &mut stream, &mut output, n_cols, n_freq_bins,
                req.start_sec, req.hop_size, req.fft_size, sample_rate, false,
            );
        }

        return Ok(build_spectrogram_response(
            n_cols, n_freq_bins, req.start_sec, actual_duration_sec, sample_rate, &output,
        ));
    }

    // Standard STFT path for fine-detail tiers.
    //
    // ── Why we decode extra context on both sides ───────────────────────────
    // A Hanning-windowed STFT column at time t has its energy centered at t
    // but draws samples from [t - fft_size/2, t + fft_size/2]. If we only
    // decoded [start_sec, start_sec + duration_sec), then:
    //  - Column 0 (centered at start_sec) would have its left half filled
    //    with zero-padded silence → dark stripe at the left edge of the chunk.
    //  - The last column near the chunk end would have its right half zeros
    //    → dark stripe at the right edge.
    // When chunks are stitched together in Spectrogram.tsx, these edge
    // stripes would show up as visible gaps at chunk boundaries. This bug
    // was the chunk-boundary gap reported 2026-04; the fix lives here AND
    // in decoder.rs (sample-accurate seeking).
    //
    // So we decode up to half an FFT window of pre-context and half a
    // window of post-context around the requested range, and run the STFT
    // over the padded buffer. Column 0's Hanning center then lands exactly
    // at req.start_sec with real audio on both sides of it.
    //
    // ── Why actual_duration_sec is n_cols * hop / sample_rate ─────────────
    // The renderer maps t -> col via
    //   col = round((t - chunk.startSec) * (chunk.nCols / chunk.actualDurationSec))
    // For that to match the *real* col grid (col k centered at chunk.startSec
    // + k * hop_size / sample_rate), the reported ratio must equal the true
    // sample_rate / hop_size. Since n_cols is integer-truncated, the only way
    // to keep the ratio exact is to set actual_duration_sec to
    // n_cols * hop_size / sample_rate. Any other value (e.g. req.duration_sec)
    // introduces a sub-col linear drift across the chunk that shows up as
    // time-axis shimmer in adjacent chunks during scroll/pan.
    //
    // Side effect: the chunk's reported extent is up to ~1/cps_real shorter
    // than chunk_duration. The per-pixel chunk lookup still routes by chunk
    // index (floor(t / chunk_duration)) so no chunk is "missed"; the renderer
    // just clamps to the last col for the few ms between the last col centre
    // and the next chunk's first col centre.
    let half_window = req.fft_size / 2;
    let half_window_sec = half_window as f64 / sample_rate as f64;

    let pre_sec = req.start_sec.min(half_window_sec);
    let decode_start = req.start_sec - pre_sec;
    let decode_duration = pre_sec + req.duration_sec + half_window_sec;

    // Pooled + forward-seeked when possible, so consecutive chunks (panning,
    // playback, a viewport's chunks arriving one after another) do not each
    // re-scan the container from byte 0. The default margin keeps the
    // sample-accuracy contract this path depends on.
    let raw_samples = {
        let mut stream =
            stream_pool::acquire(&req.path, decode_start, decoder::DEFAULT_SEEK_MARGIN_SEC)
                .map_err(|e| e.to_string())?;
        let (samples, _) = decoder::read_mono_range(&mut stream, decode_duration);
        samples
    };

    let pre_samples_decoded = (pre_sec * sample_rate as f64).round() as usize;
    let zero_pad = half_window.saturating_sub(pre_samples_decoded);
    let mut samples = vec![0.0f32; zero_pad];
    samples.extend_from_slice(&raw_samples);
    // Right-pad with half a window of zeros, mirroring the left-side zero-pad.
    // At EOF the decoder stops early, leaving the last column's right half
    // truncated, which makes n_cols * hop/sr fall short of the file's true
    // duration; the frontend then clamps every pixel in that gap to the last
    // real column, producing a visible horizontal smear. Adding half_window
    // zeros ensures actual_duration_sec >= duration so the clamp never fires.
    // For non-EOF chunks it adds one extra STFT column beyond req.duration_sec,
    // but the nCols/actualDurationSec ratio is preserved so the t→col mapping
    // is unaffected and the extra column is never rendered.
    samples.resize(samples.len() + half_window, 0.0);

    let data = fft::compute_stft(&samples, req.fft_size, req.hop_size);
    let n_cols = if n_freq_bins > 0 { data.len() / n_freq_bins } else { 0 };
    let actual_duration_sec = n_cols as f64 * req.hop_size as f64 / sample_rate as f64;

    Ok(build_spectrogram_response(
        n_cols, n_freq_bins, req.start_sec, actual_duration_sec, sample_rate, &data,
    ))
}



// ── Spectrogram chunk range (one forward pass) ────────────────────────────────

#[derive(Deserialize)]
pub struct SpectrogramRangeRequest {
    pub path: String,
    /// Index of the first chunk on the tier's grid; chunk k starts at
    /// k * chunk_duration seconds.
    pub first_chunk_index: u32,
    pub n_chunks: u32,
    pub chunk_duration: f64,
    pub fft_size: usize,
    pub hop_size: usize,
}

/// Prefix a chunk blob with its grid index so the receiver can place it without
/// relying on arrival order.
fn build_range_message(chunk_index: u32, mut chunk: Vec<u8>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(4 + chunk.len());
    bytes.extend_from_slice(&chunk_index.to_le_bytes());
    bytes.append(&mut chunk);
    bytes
}

fn compute_spectrogram_range(
    req: &SpectrogramRangeRequest,
    on_chunk: &Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let info = decoder::get_file_info(&req.path).map_err(|e| e.to_string())?;
    let sample_rate = info.sample_rate;
    let n_freq_bins = req.fft_size / 2;

    let chunk_start = |i: u32| (req.first_chunk_index + i) as f64 * req.chunk_duration;

    // Fine tiers decode their span sequentially anyway, so there is no shared
    // walk to exploit; compute them one at a time. They still arrive over the
    // channel as they finish, so the caller's handling is uniform.
    if !is_coarse_hop(req.hop_size, sample_rate) {
        for i in 0..req.n_chunks {
            let start_sec = chunk_start(i);
            if start_sec >= info.duration_secs {
                break;
            }
            let bytes = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                path: req.path.clone(),
                start_sec,
                duration_sec: req.chunk_duration,
                fft_size: req.fft_size,
                hop_size: req.hop_size,
            })?;
            on_chunk
                .send(InvokeResponseBody::Raw(build_range_message(
                    req.first_chunk_index + i,
                    bytes,
                )))
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Coarse tiers: ONE stream walked forward across every chunk in the range.
    //
    // Each chunk otherwise opens its own PcmStream, and an open scans the
    // container from byte 0 to the chunk's start — ~230ms at 25h into a 50h MP3.
    // Four chunks covering that file re-scan 0h, 12h, 25h and 37h of it, ~2.5x
    // the bytes a single pass touches, as four concurrent readers. Extending one
    // forward walk across the range collapses that to a single pass, which
    // matters most on the slow disks and external drives this is worst on.
    let mut stream = stream_pool::acquire(&req.path, chunk_start(0), COARSE_SEEK_MARGIN_SEC)
        .map_err(|e| e.to_string())?;

    for i in 0..req.n_chunks {
        let start_sec = chunk_start(i);
        if start_sec >= info.duration_secs {
            break;
        }
        let (n_cols, actual_duration_sec) = coarse_geometry(
            start_sec, req.chunk_duration, info.duration_secs, req.hop_size, sample_rate,
        );
        let mut output = vec![0u16; n_cols * n_freq_bins];
        // seek_first only for chunks after the first: open() already positioned
        // the stream at chunk 0's start.
        coarse_columns(
            &mut stream, &mut output, n_cols, n_freq_bins,
            start_sec, req.hop_size, req.fft_size, sample_rate, i > 0,
        );
        let bytes = build_spectrogram_response(
            n_cols, n_freq_bins, start_sec, actual_duration_sec, sample_rate, &output,
        );
        on_chunk
            .send(InvokeResponseBody::Raw(build_range_message(
                req.first_chunk_index + i,
                bytes,
            )))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Compute a contiguous run of spectrogram chunks in one forward pass, streaming
/// each to the frontend over `on_chunk` as it completes.
///
/// Progressive delivery is the point as much as the shared walk: a coarse range
/// covering hours of audio takes long enough on a slow machine that returning
/// only at the end would leave the view blank throughout.
#[tauri::command]
pub async fn get_spectrogram_chunk_range(
    req: SpectrogramRangeRequest,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || compute_spectrogram_range(&req, &on_chunk))
        .await
        .map_err(|e| format!("spectrogram range task failed: {e}"))?
}

// ── PCM streaming commands ────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PcmStreamHandle {
    pub stream_id: u64,
    pub sample_rate: u32,
    pub channels: u16,
    /// Total frames in the file (duration_secs * sample_rate), for scheduling.
    pub total_frames: u64,
}

#[derive(Serialize)]
pub struct PcmChunkResult {
    /// Interleaved f32 samples. len() == frames_read * channels.
    pub samples: Vec<f32>,
    pub frames_read: u32,
    /// Absolute frame index of samples[0] in the file.
    pub start_frame: u64,
}

/// Open a PCM stream at `start_sec` in the given file. Returns a handle the
/// client uses for subsequent `read_pcm_chunk` / `close_pcm_stream` calls.
#[tauri::command]
pub async fn start_pcm_stream(
    path: String,
    start_sec: f64,
    state: tauri::State<'_, PcmStreamState>,
) -> Result<PcmStreamHandle, String> {
    let info = decoder::get_file_info(&path).map_err(|e| e.to_string())?;
    let stream = decoder::PcmStream::open(&path, start_sec).map_err(|e| e.to_string())?;

    let sample_rate = stream.sample_rate();
    let channels = stream.channels();
    let total_frames = (info.duration_secs * sample_rate as f64).round() as u64;

    let stream_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    {
        let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
        // Reap idle streams on each open so the registry doesn't grow unboundedly
        // if the frontend crashes without calling close_pcm_stream.
        reap_idle_streams(&mut streams);
        streams.insert(stream_id, StreamEntry {
            stream: Arc::new(Mutex::new(stream)),
            last_used: Instant::now(),
        });
    }

    Ok(PcmStreamHandle { stream_id, sample_rate, channels, total_frames })
}

/// Read up to `max_frames` interleaved f32 frames from an open stream.
/// Returns `frames_read == 0` when the stream has reached EOF.
///
/// Note on transport size: 2s of 48kHz stereo f32 as JSON is ~1.5MB.
/// Callers should use chunk sizes of 0.5–1s to keep individual responses
/// manageable. A future optimization may switch to a binary transport.
#[tauri::command]
pub async fn read_pcm_chunk(
    stream_id: u64,
    max_frames: u32,
    state: tauri::State<'_, PcmStreamState>,
) -> Result<PcmChunkResult, String> {
    // Step 1: under the global lock, look up the per-stream Arc and update
    // `last_used`. We release the global lock immediately so other streams
    // can be accessed concurrently while this stream is reading.
    let stream_arc = {
        let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
        // Opportunistically reap idle entries each read so they don't linger.
        reap_idle_streams(&mut streams);
        let entry = streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("No stream with id {stream_id}"))?;
        entry.last_used = Instant::now();
        Arc::clone(&entry.stream)
        // global lock released here
    };

    // Step 2: lock only *this* stream for the duration of the read. Reads on
    // different streams now run fully in parallel.
    let mut stream = stream_arc.lock().map_err(|e| e.to_string())?;
    let start_frame = stream.position_frames();
    let (samples, frames_read) = stream.read(max_frames as usize).map_err(|e| e.to_string())?;

    Ok(PcmChunkResult {
        samples,
        frames_read: frames_read as u32,
        start_frame,
    })
}

/// Close and drop a PCM stream. Safe to call even if the stream has reached EOF.
#[tauri::command]
pub async fn close_pcm_stream(
    stream_id: u64,
    state: tauri::State<'_, PcmStreamState>,
) -> Result<(), String> {
    state
        .streams
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&stream_id);
    Ok(())
}

#[cfg(test)]
mod coarse_bench {
    use super::*;
    use std::time::Instant;

    /// Wall-clock cost of the coarse (sampled) spectrogram path on a real long
    /// file. #[ignore]d — needs a fixture:
    ///   SEEK_BENCH_FILE=/path/to/long.mp3 \
    ///     cargo test --release coarse_bench -- --ignored --nocapture
    /// Does batching a contiguous run into one forward walk beat fetching the
    /// chunks in parallel, each on its own stream? Batching does strictly less
    /// I/O (one container pass instead of one per chunk, each from byte 0) but
    /// serializes CPU that would otherwise run on several cores.
    #[test]
    #[ignore]
    fn range_walk_vs_parallel_chunks() {
        let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
        let info = decoder::get_file_info(&path).expect("info");
        let sr = info.sample_rate as usize;
        // The whole-file view of this file: 4 chunks of 1024 columns.
        let hop = 2_097_152usize;
        let chunk_duration = 1024.0 * hop as f64 / sr as f64;
        let n_chunks = 4u32;

        // A: four independent chunk computations, in parallel.
        let t = Instant::now();
        std::thread::scope(|scope| {
            for i in 0..n_chunks {
                let path = path.clone();
                scope.spawn(move || {
                    let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                        path,
                        start_sec: i as f64 * chunk_duration,
                        duration_sec: chunk_duration,
                        fft_size: 2048,
                        hop_size: hop,
                    });
                });
            }
        });
        println!("parallel per-chunk ({n_chunks} chunks): {:?}", t.elapsed());

        // B: one forward walk covering the same range.
        let t = Instant::now();
        let n_freq_bins = 1024usize;
        let mut stream = decoder::PcmStream::open(&path, 0.0).expect("open");
        for i in 0..n_chunks {
            let start_sec = i as f64 * chunk_duration;
            let (n_cols, _) = coarse_geometry(
                start_sec, chunk_duration, info.duration_secs, hop, info.sample_rate,
            );
            let mut output = vec![0u16; n_cols * n_freq_bins];
            coarse_columns(
                &mut stream, &mut output, n_cols, n_freq_bins,
                start_sec, hop, 2048, info.sample_rate, i > 0,
            );
        }
        println!("single forward walk ({n_chunks} chunks): {:?}", t.elapsed());

        // C: split into parallel walks of `per` chunks each.
        for per in [2u32, 1] {
            let t = Instant::now();
            std::thread::scope(|scope| {
                for w in 0..(n_chunks / per) {
                    let path = path.clone();
                    scope.spawn(move || {
                        let first = w * per;
                        let mut stream =
                            decoder::PcmStream::open(&path, first as f64 * chunk_duration).unwrap();
                        for i in 0..per {
                            let start_sec = (first + i) as f64 * chunk_duration;
                            let (n_cols, _) = coarse_geometry(
                                start_sec, chunk_duration, info.duration_secs, hop, info.sample_rate,
                            );
                            let mut output = vec![0u16; n_cols * 1024];
                            coarse_columns(
                                &mut stream, &mut output, n_cols, 1024,
                                start_sec, hop, 2048, info.sample_rate, i > 0,
                            );
                        }
                    });
                }
            });
            println!("{} parallel walks of {per} chunks: {:?}", n_chunks / per, t.elapsed());
        }
    }

    /// Fine-tier chunk cost at increasing depth into a long file. Each chunk
    /// opens its own decoder, and the container open scans from byte 0.
    #[test]
    #[ignore]
    fn fine_chunk_cost_by_depth() {
        let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
        let info = decoder::get_file_info(&path).expect("info");
        let sr = info.sample_rate as usize;
        let hop = 512usize;
        let chunk_duration = 1024.0 * hop as f64 / sr as f64;
        println!("fine chunk = {chunk_duration:.1}s");

        for frac in [0.0, 0.1, 0.5, 0.9] {
            let start = info.duration_secs * frac;
            let t = Instant::now();
            let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                path: path.clone(),
                start_sec: start,
                duration_sec: chunk_duration,
                fft_size: 2048,
                hop_size: hop,
            }).expect("chunk");
            println!("  fine chunk @ {start:8.0}s: {:?}", t.elapsed());
        }

        // Panning deep in the file: consecutive chunks, one after another.
        // Without stream reuse each pays its own full container scan.
        let base = info.duration_secs * 0.9;
        for reuse in [false, true] {
            let label = if reuse { "with stream reuse" } else { "no reuse" };
            stream_pool::clear();
            let t = Instant::now();
            for i in 0..6 {
                if !reuse {
                    stream_pool::clear(); // force a fresh open per chunk
                }
                let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                    path: path.clone(),
                    start_sec: base + i as f64 * chunk_duration,
                    duration_sec: chunk_duration,
                    fft_size: 2048,
                    hop_size: hop,
                }).expect("chunk");
            }
            let el = t.elapsed();
            println!("  6 sequential fine chunks @ {base:.0}s ({label}): {el:?} total, {:?}/chunk", el / 6);
        }

        // Four such chunks (a typical zoomed-in viewport) in parallel, deep in.
        let base = info.duration_secs * 0.9;
        let t = Instant::now();
        std::thread::scope(|scope| {
            for i in 0..4 {
                let path = path.clone();
                scope.spawn(move || {
                    let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                        path,
                        start_sec: base + i as f64 * chunk_duration,
                        duration_sec: chunk_duration,
                        fft_size: 2048,
                        hop_size: hop,
                    });
                });
            }
        });
        println!("  4 parallel fine chunks @ {base:.0}s: {:?}", t.elapsed());
    }

    /// Phase breakdown for one coarse chunk: seek vs decode vs FFT.
    #[test]
    #[ignore]
    fn coarse_phase_breakdown() {
        let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
        let info = decoder::get_file_info(&path).expect("info");
        let sr = info.sample_rate as usize;
        let fft_size = 2048usize;
        let hop = 2_097_152usize; // coarsest selected tier for a 50h file
        let n_cols = 64usize;     // sample of a 1024-col chunk
        // One FFT window per column, matching what coarse tiers do since pooling
        // was dropped.
        let pool_frames = fft_size;
        println!("sr={sr} pool_frames={pool_frames} hop={hop}");

        let mut stream = decoder::PcmStream::open(&path, 0.0).expect("open");
        let ch = stream.channels().max(1) as usize;
        let mut mono = vec![0.0f32; pool_frames];
        let (mut t_seek, mut t_read, mut t_fft) = (
            std::time::Duration::ZERO, std::time::Duration::ZERO, std::time::Duration::ZERO);

        for col in 0..n_cols {
            let t = (col * hop) as f64 / sr as f64;
            let t0 = Instant::now();
            if col > 0 && stream.seek_to(t, COARSE_SEEK_MARGIN_SEC).is_err() { break; }
            t_seek += t0.elapsed();

            let t0 = Instant::now();
            let mut filled = 0usize;
            while filled < pool_frames {
                let (inter, n) = match stream.read(pool_frames - filled) { Ok(r) => r, Err(_) => break };
                if n == 0 { break; }
                for f in 0..n {
                    let mut sum = 0.0f32;
                    for c in 0..ch { sum += inter[f * ch + c]; }
                    mono[filled + f] = sum / ch as f32;
                }
                filled += n;
            }
            t_read += t0.elapsed();

            let t0 = Instant::now();
            let _ = fft::compute_stft(&mono[..filled], fft_size, fft_size);
            t_fft += t0.elapsed();
        }
        println!("{n_cols} cols: seek {t_seek:?}, read+mixdown {t_read:?}, fft {t_fft:?}");
        println!("=> per 1024-col chunk: seek {:?}, read {:?}, fft {:?}",
                 t_seek * 16, t_read * 16, t_fft * 16);
    }

    /// End-to-end cost of the whole-file overview — the one request a user
    /// sits and waits on when a long file is first opened.
    ///
    /// Derives the hop from the fixture's own length instead of hardcoding one,
    /// so it exercises the real coarsest tier for any file. That matters for
    /// `.wma`, where the backend is a subprocess and the per-column seek
    /// strategy (read forward vs. respawn ffmpeg) decides the whole cost:
    ///
    ///   SEEK_BENCH_FILE=/path/to/long.wma \
    ///     cargo test --release overview_build_cost -- --ignored --nocapture
    #[test]
    #[ignore]
    fn overview_build_cost() {
        let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
        let info = decoder::get_file_info(&path).expect("info");
        let hop = ((info.duration_secs * info.sample_rate as f64) / 1024.0).max(1.0) as usize;
        println!(
            "dur={:.0}s sr={} hop={hop} (~1024 cols spanning the whole file)",
            info.duration_secs, info.sample_rate
        );

        let t = Instant::now();
        let blob = compute_spectrogram_chunk(&SpectrogramChunkRequest {
            path,
            start_sec: 0.0,
            duration_sec: info.duration_secs,
            fft_size: 2048,
            hop_size: hop,
        })
        .expect("chunk");
        println!("whole-file overview: {:?} ({} bytes)", t.elapsed(), blob.len());
    }

    #[test]
    #[ignore]
    fn coarse_chunk_cost() {
        let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
        let info = decoder::get_file_info(&path).expect("info");
        let sr = info.sample_rate as usize;

        for (label, hop, dur) in [
            ("tier0 hop=1s  chunk=600s", sr, 600.0),
            ("hop=44s       chunk=512col", sr * 44, 512.0 * 44.0),
        ] {
            for start in [0.0, info.duration_secs * 0.5] {
                let req = SpectrogramChunkRequest {
                    path: path.clone(),
                    start_sec: start,
                    duration_sec: dur,
                    fft_size: 2048,
                    hop_size: hop,
                };
                let t = Instant::now();
                let bytes = compute_spectrogram_chunk(&req).expect("chunk");
                let n_cols = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
                println!("{label} @ {start:.0}s: {:?} ({n_cols} cols)", t.elapsed());
            }
        }
    }
}

#[cfg(test)]
mod range_tests {
    use super::*;

    /// Write a mono 16-bit WAV whose content varies over time, so a column
    /// computed at the wrong position is detectable.
    fn write_test_wav(name: &str, sample_rate: u32, secs: f64) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let n_frames = (sample_rate as f64 * secs) as usize;
        let data_bytes = (n_frames * 2) as u32;
        let mut wav: Vec<u8> = Vec::with_capacity(44 + data_bytes as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        // A tone whose frequency rises over the file: every position in time has
        // a distinct spectrum, so a misplaced column shows up as a mismatch.
        for i in 0..n_frames {
            let t = i as f64 / sample_rate as f64;
            let freq = 200.0 + 60.0 * t;
            let v = (2.0 * std::f64::consts::PI * freq * t).sin() * 20000.0;
            wav.extend_from_slice(&(v as i16).to_le_bytes());
        }
        std::fs::write(&path, wav).expect("write test wav");
        path
    }

    /// The shared forward walk must produce byte-identical chunks to computing
    /// each one on its own stream — otherwise coarse tiers would disagree with
    /// themselves depending on how the renderer happened to batch requests.
    #[test]
    fn range_walk_matches_per_chunk_computation() {
        let sr = 8000u32;
        let path = write_test_wav("seenote_range_walk.wav", sr, 40.0);
        let p = path.to_str().unwrap().to_string();
        let fft_size = 256usize;
        let hop_size = 8000usize; // 1s hop: comfortably in the coarse path
        let chunk_duration = 8.0;
        let n_chunks = 4u32;

        // Per-chunk reference: a fresh stream for each chunk.
        let mut expected: Vec<Vec<u8>> = Vec::new();
        for i in 0..n_chunks {
            expected.push(
                compute_spectrogram_chunk(&SpectrogramChunkRequest {
                    path: p.clone(),
                    start_sec: i as f64 * chunk_duration,
                    duration_sec: chunk_duration,
                    fft_size,
                    hop_size,
                })
                .expect("chunk"),
            );
        }

        // The range walk reuses one stream across all four.
        let range = SpectrogramRangeRequest {
            path: p.clone(),
            first_chunk_index: 0,
            n_chunks,
            chunk_duration,
            fft_size,
            hop_size,
        };
        let info = decoder::get_file_info(&p).expect("info");
        let sample_rate = info.sample_rate;
        let n_freq_bins = fft_size / 2;
        let mut stream = decoder::PcmStream::open(&p, 0.0).expect("open");
        for i in 0..n_chunks {
            let start_sec = i as f64 * chunk_duration;
            let (n_cols, actual_duration_sec) = coarse_geometry(
                start_sec, chunk_duration, info.duration_secs, hop_size, sample_rate,
            );
            let mut output = vec![0u16; n_cols * n_freq_bins];
            coarse_columns(
                &mut stream, &mut output, n_cols, n_freq_bins,
                start_sec, hop_size, fft_size, sample_rate, i > 0,
            );
            let got = build_spectrogram_response(
                n_cols, n_freq_bins, start_sec, actual_duration_sec, sample_rate, &output,
            );
            assert_eq!(
                got, expected[i as usize],
                "chunk {i} from the shared walk differs from its standalone computation"
            );
        }
        let _ = range.n_chunks; // request shape is exercised by the command itself
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn range_message_carries_its_grid_index() {
        let msg = build_range_message(7, vec![1, 2, 3]);
        assert_eq!(u32::from_le_bytes(msg[0..4].try_into().unwrap()), 7);
        assert_eq!(&msg[4..], &[1, 2, 3]);
    }

    #[test]
    fn coarse_geometry_keeps_the_column_rate_exact() {
        let sr = 48000u32;
        let hop = 96000usize; // 2s
        let (n_cols, dur) = coarse_geometry(0.0, 60.0, 600.0, hop, sr);
        // n_cols / dur must equal the true cps so columns land on real centres.
        assert!(((n_cols as f64 / dur) - (sr as f64 / hop as f64)).abs() < 1e-9);
        // A chunk running past EOF is truncated to what the file holds.
        let (n_cols_eof, _) = coarse_geometry(590.0, 60.0, 600.0, hop, sr);
        assert!(n_cols_eof < n_cols);
    }
}
