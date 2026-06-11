use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use crate::audio::{decoder, fft};
use tauri::ipc::Response;

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

// ── Spectrogram chunk ─────────────────────────────────────────────────────────

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

#[tauri::command]
pub async fn get_spectrogram_chunk(
    req: SpectrogramChunkRequest,
) -> Result<Response, String> {
    let info = decoder::get_file_info(&req.path).map_err(|e| e.to_string())?;
    let sample_rate = info.sample_rate;
    let n_freq_bins = req.fft_size / 2;

    // For very large hop sizes (coarse overview tiers), use a sampled approach:
    // seek to each column position and decode one FFT window instead of
    // decoding the entire range and running a full STFT.
    if req.hop_size >= (sample_rate as usize) / 2 {
        let window_dur = req.fft_size as f64 / sample_rate as f64;
        let actual_end = (req.start_sec + req.duration_sec).min(info.duration_secs);
        let chunk_duration = actual_end - req.start_sec;
        let n_cols = ((chunk_duration * sample_rate as f64) / req.hop_size as f64).floor() as usize + 1;
        // Same invariant as the standard STFT path: nCols / actualDurationSec
        // must equal the true cps (= sample_rate / hop_size) so the renderer
        // places cols at their real centres. See the long comment below.
        let actual_duration_sec = n_cols as f64 * req.hop_size as f64 / sample_rate as f64;

        let mut output = vec![0u16; n_cols * n_freq_bins];
        for col in 0..n_cols {
            let t = req.start_sec + (col as f64 * req.hop_size as f64 / sample_rate as f64);
            if let Ok((samples, _)) = decoder::decode_audio_range(&req.path, t, window_dur) {
                if samples.len() >= req.fft_size {
                    let col_data = fft::compute_stft(&samples[..req.fft_size], req.fft_size, req.fft_size);
                    if col_data.len() >= n_freq_bins {
                        output[col * n_freq_bins..(col + 1) * n_freq_bins]
                            .copy_from_slice(&col_data[..n_freq_bins]);
                    }
                }
            }
        }

        let bytes = build_spectrogram_response(
            n_cols, n_freq_bins, req.start_sec, actual_duration_sec, sample_rate, &output,
        );
        return Ok(Response::new(bytes));
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

    let (raw_samples, _) =
        decoder::decode_audio_range(&req.path, decode_start, decode_duration)
            .map_err(|e| e.to_string())?;

    let pre_samples_decoded = (pre_sec * sample_rate as f64).round() as usize;
    let zero_pad = half_window.saturating_sub(pre_samples_decoded);
    let mut samples = vec![0.0f32; zero_pad];
    samples.extend_from_slice(&raw_samples);

    let data = fft::compute_stft(&samples, req.fft_size, req.hop_size);
    let n_cols = if n_freq_bins > 0 { data.len() / n_freq_bins } else { 0 };
    let actual_duration_sec = n_cols as f64 * req.hop_size as f64 / sample_rate as f64;

    let bytes = build_spectrogram_response(
        n_cols, n_freq_bins, req.start_sec, actual_duration_sec, sample_rate, &data,
    );
    Ok(Response::new(bytes))
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
