use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use crate::audio::{decoder, lock, spectrogram, stream_pool, wav};
use tauri::ipc::{Channel, InvokeResponseBody, Response};

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
    ///
    /// Held as a `PooledStream` so that dropping the entry — on
    /// `close_pcm_stream`, or on idle-TTL eviction — hands the positioned
    /// decoder back to `stream_pool` rather than discarding it. A later play or
    /// seek at or after that position then reuses it instead of re-scanning the
    /// container.
    stream: Arc<Mutex<stream_pool::PooledStream>>,
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
///
/// The evicted entries are returned, not dropped: dropping one hands its
/// decoder to `stream_pool` (and may kill an ffmpeg child), which must happen
/// after the caller releases the registry lock.
#[must_use]
fn reap_idle_streams(streams: &mut HashMap<u64, StreamEntry>) -> Vec<StreamEntry> {
    let now = Instant::now();
    let expired: Vec<u64> = streams
        .iter()
        .filter(|(_, entry)| now.duration_since(entry.last_used) >= STREAM_TTL)
        .map(|(id, _)| *id)
        .collect();
    expired
        .into_iter()
        .filter_map(|id| {
            eprintln!("PcmStream {id}: evicted after idle TTL ({STREAM_TTL:?})");
            streams.remove(&id)
        })
        .collect()
}

/// Run blocking work (container scans, decoding, ffprobe/ffmpeg spawns) off the
/// async runtime's worker threads, so a slow drive stalls only its own command
/// rather than every IPC call queued behind it.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("audio task failed: {e}"))?
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
    blocking(move || {
        decoder::get_file_info(&path)
            .map(|i| FileInfoResult {
                duration_secs: i.duration_secs,
                sample_rate: i.sample_rate,
                channels: i.channels,
            })
            .map_err(|e| e.to_string())
    })
    .await
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

/// Full path of the `ffmpeg` binary currently in use — the configured one if
/// Application Settings names a working location, otherwise whatever the
/// automatic search found (PATH, then the usual install locations). `None`
/// means nothing usable was found. Shown in the settings field so the user can
/// see whether detection succeeded.
#[tauri::command]
pub async fn detect_ffmpeg() -> Result<Option<String>, String> {
    // The search spawns `ffmpeg -version` per candidate directory.
    blocking(|| Ok(crate::audio::ffmpeg_stream::detected_ffmpeg_path())).await
}

// ── Peak amplitude (for loudness normalization) ────────────────────────────────

/// Peak absolute sample amplitude of the whole file, on the mono mixdown (the
/// same averaged-across-channels signal the playback path produces). Returned
/// in [0, 1] for normal float PCM. Used by the example-clip player to compute a
/// normalization gain so quiet and loud clips preview at a comparable level.
///
/// Streams through the file in bounded chunks with a running max, so memory
/// stays flat; it still decodes the whole file, so it is meant for the short
/// example clips, not full recordings.
#[tauri::command]
pub async fn audio_peak(path: String) -> Result<f32, String> {
    blocking(move || audio_peak_blocking(&path)).await
}

fn audio_peak_blocking(path: &str) -> Result<f32, String> {
    const CHUNK_FRAMES: usize = 64 * 1024;
    let mut stream = decoder::PcmStream::open(path, 0.0).map_err(|e| e.to_string())?;
    let ch = stream.channels().max(1) as usize;
    let mut peak = 0.0f32;
    loop {
        let (interleaved, frames_read) = stream.read(CHUNK_FRAMES).map_err(|e| e.to_string())?;
        if frames_read == 0 {
            return Ok(peak);
        }
        peak = decoder::mix_to_mono(&interleaved, ch).fold(peak, |m, s| m.max(s.abs()));
    }
}

/// Compute a contiguous run of spectrogram chunks in one forward pass, streaming
/// each to the frontend over `on_chunk` as it completes.
///
/// Progressive delivery is the point as much as the shared walk: a coarse range
/// covering hours of audio takes long enough on a slow machine that returning
/// only at the end would leave the view blank throughout.
#[tauri::command]
pub async fn get_spectrogram_chunk_range(
    req: spectrogram::SpectrogramRangeRequest,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        spectrogram::compute_spectrogram_range(&req, &mut |message| {
            on_chunk.send(InvokeResponseBody::Raw(message)).map_err(|e| e.to_string())
        })
    })
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

/// Encode a `read_pcm_chunk` result into a binary blob for IPC — same pattern
/// as `build_spectrogram_response` on the spectrogram path.
///
/// JSON-serializing a chunk this size (via `#[derive(Serialize)]` + Tauri's
/// default IPC) measured ~2ms to encode 1s of 44.1kHz stereo audio and ~4ms for
/// 96kHz, release build, before counting the ~2.3x larger over-the-wire payload
/// or the frontend's `JSON.parse` cost — pure CPU overhead on the hottest
/// streaming path in the app (this command is called roughly once per second
/// of played audio, and back-to-back with no throttling while `PcmCache`
/// primes a selection). Binary encoding measured ~50x faster to produce.
///
/// Header layout (12 bytes, little-endian):
///   u32  frames_read
///   u64  start_frame
/// Followed by frames_read * channels f32 samples (little-endian), interleaved.
fn build_pcm_chunk_response(frames_read: u32, start_frame: u64, samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(12 + samples.len() * 4);
    bytes.extend_from_slice(&frames_read.to_le_bytes());
    bytes.extend_from_slice(&start_frame.to_le_bytes());
    for &v in samples {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Open a PCM stream at `start_sec` in the given file. Returns a handle the
/// client uses for subsequent `read_pcm_chunk` / `close_pcm_stream` calls.
///
/// Goes through `stream_pool` rather than opening the decoder directly. An MP3
/// carries no seek index, so opening one at time T scans the container from
/// byte 0 to T — 122-310ms at depth in a long file (see `decoder::seek_bench`
/// and `audio::stream_pool`). Playback opened a fresh stream on every play,
/// resume and seek and paid that scan every time, which is the gap between
/// pressing space and hearing audio. The pool hands back a stream already
/// positioned at or before the target whenever one is idle, turning the scan
/// into a short forward seek; when none is, it opens fresh exactly as before.
#[tauri::command]
pub async fn start_pcm_stream(
    path: String,
    start_sec: f64,
    state: tauri::State<'_, PcmStreamState>,
) -> Result<PcmStreamHandle, String> {
    // The scan to `start_sec` and the info probe both hit the disk.
    let (stream, total_frames) = blocking(move || {
        let info = decoder::get_file_info(&path).map_err(|e| e.to_string())?;
        let stream = stream_pool::acquire(&path, start_sec, decoder::DEFAULT_SEEK_MARGIN_SEC)
            .map_err(|e| e.to_string())?;
        let total_frames = (info.duration_secs * stream.sample_rate() as f64).round() as u64;
        Ok((stream, total_frames))
    })
    .await?;

    let sample_rate = stream.sample_rate();
    let channels = stream.channels();

    let stream_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let evicted = {
        let mut streams = lock(&state.streams);
        // Reap idle streams on each open so the registry doesn't grow unboundedly
        // if the frontend crashes without calling close_pcm_stream.
        let evicted = reap_idle_streams(&mut streams);
        streams.insert(stream_id, StreamEntry {
            stream: Arc::new(Mutex::new(stream)),
            last_used: Instant::now(),
        });
        evicted
    };
    drop(evicted);

    Ok(PcmStreamHandle { stream_id, sample_rate, channels, total_frames })
}

/// Read up to `max_frames` interleaved f32 frames from an open stream.
/// Returns `frames_read == 0` when the stream has reached EOF.
///
/// Binary IPC response (see `build_pcm_chunk_response`) rather than JSON —
/// this is called roughly once per second of played audio.
#[tauri::command]
pub async fn read_pcm_chunk(
    stream_id: u64,
    max_frames: u32,
    state: tauri::State<'_, PcmStreamState>,
) -> Result<Response, String> {
    // Step 1: under the global lock, look up the per-stream Arc and update
    // `last_used`. We release the global lock immediately so other streams
    // can be accessed concurrently while this stream is reading.
    let (stream_arc, evicted) = {
        let mut streams = lock(&state.streams);
        // Opportunistically reap idle entries each read so they don't linger.
        let evicted = reap_idle_streams(&mut streams);
        let entry = streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("No stream with id {stream_id}"))?;
        entry.last_used = Instant::now();
        (Arc::clone(&entry.stream), evicted)
        // global lock released here
    };
    drop(evicted);

    // Step 2: lock only *this* stream for the duration of the read, on a
    // blocking thread (a read can decode several packets, or wait on an ffmpeg
    // pipe). Reads on different streams run fully in parallel.
    blocking(move || {
        let mut stream = lock(&stream_arc);
        let start_frame = stream.position_frames();
        let (samples, frames_read) = stream.read(max_frames as usize).map_err(|e| e.to_string())?;
        Ok(Response::new(build_pcm_chunk_response(
            frames_read as u32,
            start_frame,
            &samples,
        )))
    })
    .await
}

/// Close and drop a PCM stream. Safe to call even if the stream has reached EOF.
#[tauri::command]
pub async fn close_pcm_stream(
    stream_id: u64,
    state: tauri::State<'_, PcmStreamState>,
) -> Result<(), String> {
    // Bind the removed entry so it is dropped after the guard is released.
    let removed = lock(&state.streams).remove(&stream_id);
    drop(removed);
    Ok(())
}

// ── Audio range export ────────────────────────────────────────────────────────

/// Decode `[start_sec, start_sec + duration_sec)` of `source_path`, preserving
/// its channel count (unlike `decode_audio_range`, which mixes to mono), and
/// write it to `out_path`.
///
/// `out_path`'s extension picks the output format: `.wav` is written directly;
/// anything else is produced by writing a temp WAV and shelling out to ffmpeg
/// to transcode it, so this only works for other formats when ffmpeg is
/// available (see `ffmpeg_stream::detected_ffmpeg_path`) — same fallback
/// backend the `.wma` decode path uses.
fn export_audio_range_blocking(source_path: &str, start_sec: f64, duration_sec: f64, out_path: &str) -> Result<(), String> {
    let mut stream = decoder::PcmStream::open(source_path, start_sec).map_err(|e| e.to_string())?;
    let sample_rate = stream.sample_rate();
    let channels = stream.channels().max(1);
    let total_frames = (duration_sec.max(0.0) * sample_rate as f64).round() as usize;
    // Refuse before decoding (and before reserving the buffer below) rather than
    // after minutes of work; the WAV writer re-checks the actual length.
    if total_frames as u64 * channels as u64 * 2 > wav::MAX_WAV_DATA_BYTES {
        return Err("The selected range is too long to export (over 4 GiB of audio); export a shorter range.".to_string());
    }

    let mut pcm: Vec<i16> = Vec::with_capacity(total_frames * channels as usize);
    let mut remaining = total_frames;
    while remaining > 0 {
        let (interleaved, frames_read) = stream.read(remaining.min(65536)).map_err(|e| e.to_string())?;
        if frames_read == 0 {
            break; // EOF — export whatever was decoded, shorter than requested
        }
        for &s in &interleaved[..frames_read * channels as usize] {
            pcm.push((s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16);
        }
        remaining -= frames_read;
    }

    let out = std::path::Path::new(out_path);
    let ext = out.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();

    if ext.is_empty() || ext == "wav" {
        return wav::write_wav_i16(out, sample_rate, channels, &pcm).map_err(|e| e.to_string());
    }

    let ffmpeg = crate::audio::ffmpeg_stream::detected_ffmpeg_path().ok_or_else(|| {
        format!(
            "Can't export as .{ext}: this format needs ffmpeg to convert, and no ffmpeg install \
             was found. Export as .wav instead, or set an ffmpeg path in Application Settings."
        )
    })?;

    let tmp = std::env::temp_dir().join(format!(
        "seenote_export_{}_{}.wav",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    wav::write_wav_i16(&tmp, sample_rate, channels, &pcm).map_err(|e| e.to_string())?;

    let status = std::process::Command::new(&ffmpeg)
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(&tmp)
        .arg(out_path)
        .status();
    let _ = std::fs::remove_file(&tmp);

    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("ffmpeg exited with status {s} converting to .{ext}")),
        Err(e) => Err(format!("Failed to run ffmpeg: {e}")),
    }
}

/// Export the audio in `[start_sec, start_sec + duration_sec)` of `source_path`
/// to `out_path`. Runs on a blocking thread — decode + (occasionally) an
/// ffmpeg subprocess, no await points of its own.
#[tauri::command]
pub async fn export_audio_range(
    source_path: String,
    start_sec: f64,
    duration_sec: f64,
    out_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || export_audio_range_blocking(&source_path, start_sec, duration_sec, &out_path))
        .await
        .map_err(|e| format!("export task failed: {e}"))?
}

#[cfg(test)]
#[path = "audio_export_tests.rs"]
mod export_tests;
