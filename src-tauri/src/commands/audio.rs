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

/// How much audio each column of a coarse (sampled) spectrogram tier summarizes.
///
/// The column keeps the per-bin max over the windows in this span, so the value
/// trades transient sensitivity against work: too short and brief events fall
/// between columns, too long and every column decodes audio the view can't
/// resolve. 0.3s is ~7 windows at fft_size 2048 / 48 kHz, and costs well under a
/// millisecond per column against a ~3ms seek.
const COARSE_POOL_SEC: f64 = 0.3;

/// Seek margin for the coarse column walk (see PcmStream::seek_to).
///
/// The margin is decoded and thrown away at every column, so at the default
/// 0.5s each column decoded 0.8s of audio to keep 0.3s — more than half the
/// decode wasted, on the hottest path for long files. 50ms still comfortably
/// covers a container seek landing late (an MP3 packet is ~26ms).
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

/// Decode + STFT a chunk, returning the encoded IPC blob.
///
/// Deliberately synchronous: it is pure CPU work (decode, FFT) with no await
/// points, and it runs on a blocking thread — see `get_spectrogram_chunk`.
fn compute_spectrogram_chunk(req: &SpectrogramChunkRequest) -> Result<Vec<u8>, String> {
    let info = decoder::get_file_info(&req.path).map_err(|e| e.to_string())?;
    let sample_rate = info.sample_rate;
    let n_freq_bins = req.fft_size / 2;

    // For very large hop sizes (coarse overview tiers), use a sampled approach:
    // seek to each column position and decode one FFT window instead of
    // decoding the entire range and running a full STFT.
    if req.hop_size >= (sample_rate as usize) / 2 {
        let actual_end = (req.start_sec + req.duration_sec).min(info.duration_secs);
        let chunk_duration = actual_end - req.start_sec;
        let n_cols = ((chunk_duration * sample_rate as f64) / req.hop_size as f64).floor() as usize + 1;
        // Same invariant as the standard STFT path: nCols / actualDurationSec
        // must equal the true cps (= sample_rate / hop_size) so the renderer
        // places cols at their real centres. See the long comment below.
        let actual_duration_sec = n_cols as f64 * req.hop_size as f64 / sample_rate as f64;

        let mut output = vec![0u16; n_cols * n_freq_bins];

        // Walk a SINGLE PcmStream forward, seeking from column to column.
        //
        // ── Why seek instead of read-through ────────────────────────────────
        // This path used to advance between columns by *reading and discarding*
        // the hop, which meant fully decoding the chunk's entire span to emit a
        // handful of columns — for the coarsest tier of a 50h file, decoding the
        // whole file. Measured on a 1GB / 49.7h MP3 (see decoder::seek_bench):
        //
        //   sequential decode of the whole file    ~48 s
        //   100 forward seek_to calls across it    ~0.28 s total
        //
        // Forward seeks on a reused stream resume the container scan from the
        // current position, so a full column walk costs roughly ONE pass over
        // the frame headers no matter how many columns it emits — the totals for
        // 20 and 100 columns were within 15% of each other. Only backward seeks
        // and re-opens restart the scan from byte 0 (~122 ms each at depth),
        // which a monotonically forward walk never does. The gap widens on slow
        // disks, since scanning touches a small fraction of the bytes decoding
        // would.
        //
        // ── Why pool several windows per column ─────────────────────────────
        // One fft_size window per column is 43ms of audio out of a hop that may
        // be minutes long, so a brief call between windows is simply invisible —
        // useless for spotting activity across a night. Instead each column
        // covers a short contiguous span and keeps the per-bin MAXIMUM across
        // the windows in it, the spectral analogue of a peak-preserving waveform
        // overview: a transient anywhere in the span lights its column up.
        // compute_stft's u16 encoding is monotonic in magnitude, so the max can
        // be taken directly on the encoded values.
        if let Ok(mut stream) = decoder::PcmStream::open(&req.path, req.start_sec) {
            let ch = stream.channels().max(1) as usize;
            // Audio each column summarizes. Clamped to the hop so columns never
            // overlap, and to at least one window so a column is always emittable.
            let pool_frames = ((COARSE_POOL_SEC * sample_rate as f64) as usize)
                .clamp(req.fft_size, req.hop_size.max(req.fft_size));
            let mut mono = vec![0.0f32; pool_frames];

            for col in 0..n_cols {
                // Column k is centred at start_sec + k*hop/sample_rate. Column 0
                // needs no seek: open() already positioned the stream there.
                if col > 0 {
                    let t = req.start_sec
                        + (col * req.hop_size) as f64 / sample_rate as f64;
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

                // A column needs at least one full window; a shorter tail stays 0.
                if filled < req.fft_size {
                    continue;
                }

                // Non-overlapping windows across the span, reduced by per-bin max.
                let windows = fft::compute_stft(&mono[..filled], req.fft_size, req.fft_size);
                let dst = &mut output[col * n_freq_bins..(col + 1) * n_freq_bins];
                for window in windows.chunks_exact(n_freq_bins) {
                    for (d, &s) in dst.iter_mut().zip(window) {
                        if s > *d {
                            *d = s;
                        }
                    }
                }
            }
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

    let (raw_samples, _) =
        decoder::decode_audio_range(&req.path, decode_start, decode_duration)
            .map_err(|e| e.to_string())?;

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

/// Compute one spectrogram chunk, off the async runtime's worker threads.
///
/// The work is entirely blocking CPU (symphonia decode + FFT) and can run for
/// seconds on a coarse chunk of a long file. Run directly in the async command,
/// it occupies a tokio worker for that whole time; with several chunks in flight
/// that starves every other command — including `read_pcm_chunk`, which playback
/// depends on — so the app stalls rather than just the spectrogram filling in
/// slowly. `spawn_blocking` moves it to the blocking pool, which exists for
/// exactly this and grows to fit.
#[tauri::command]
pub async fn get_spectrogram_chunk(
    req: SpectrogramChunkRequest,
) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || compute_spectrogram_chunk(&req))
        .await
        .map_err(|e| format!("spectrogram task failed: {e}"))??;
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

#[cfg(test)]
mod coarse_bench {
    use super::*;
    use std::time::Instant;

    /// Wall-clock cost of the coarse (sampled) spectrogram path on a real long
    /// file. #[ignore]d — needs a fixture:
    ///   SEEK_BENCH_FILE=/path/to/long.mp3 \
    ///     cargo test --release coarse_bench -- --ignored --nocapture
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
        let pool_frames = ((COARSE_POOL_SEC * sr as f64) as usize).clamp(fft_size, hop);
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
