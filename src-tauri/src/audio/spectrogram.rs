//! Spectrogram chunk computation: the fine tiers' padded STFT and the coarse
//! tiers' sampled column walk, plus the binary blob both are sent as. The
//! Tauri command wrapping this lives in `commands/audio.rs`.

use serde::Deserialize;

use super::{decoder, fft, stream_pool};

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

/// Largest FFT window accepted; far above anything the tiers use, it only
/// bounds the allocations a malformed request can ask for.
const MAX_FFT_SIZE: usize = 1 << 20;

/// Reject window/hop sizes the STFT cannot honour. A zero hop divides by zero in
/// the column math, and a window under 2 has no Hann window (N-1 = 0) or bins.
fn validate_stft_params(fft_size: usize, hop_size: usize) -> Result<(), String> {
    if !(2..=MAX_FFT_SIZE).contains(&fft_size) {
        return Err(format!("fft_size must be between 2 and {MAX_FFT_SIZE}, got {fft_size}"));
    }
    if hop_size == 0 {
        return Err("hop_size must be at least 1".to_string());
    }
    Ok(())
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

/// Where a coarse walk's stream must be positioned for column 0: the left edge
/// of the first window (clamped at the file start, where the walk zero-pads).
fn coarse_first_window_sec(start_sec: f64, fft_size: usize, sample_rate: u32) -> f64 {
    let centre = (start_sec * sample_rate as f64).round() as i64;
    (centre - (fft_size / 2) as i64).max(0) as f64 / sample_rate as f64
}

/// Fill `output` with `n_cols` coarse spectrogram columns starting at
/// `start_sec`, walking `stream` FORWARD. `seek_first` seeks before the first
/// column; pass false when the stream is already positioned at
/// `coarse_first_window_sec` (a fresh acquire), true when continuing from a
/// previous chunk.
///
/// Returns how many columns got any real audio; columns that did not (a failed
/// seek or read, or past EOF) stay zero. Errors only when NO column was read,
/// since an all-zero chunk is indistinguishable from silence and would be
/// cached as valid.
///
/// ── Column centring ─────────────────────────────────────────────────────────
/// Column k is centred at `start_sec + k*hop/sample_rate`, exactly like the fine
/// tier: its window spans `fft_size/2` frames either side, zero-padded before
/// the start of the file and after its end.
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
) -> Result<usize, String> {
    let ch = stream.channels().max(1) as usize;
    let half = (fft_size / 2) as i64;
    let first_centre = (start_sec * sample_rate as f64).round() as i64;
    let mut mono = vec![0.0f32; fft_size];
    let mut computer = fft::ColumnComputer::new(fft_size);
    let mut with_audio = 0usize;
    let mut last_err: Option<String> = None;

    for col in 0..n_cols {
        let win_start = first_centre + (col * hop_size) as i64 - half;
        // Frames of the window that fall before the start of the file.
        let lead = (-win_start).max(0) as usize;

        if col > 0 || seek_first {
            let t = win_start.max(0) as f64 / sample_rate as f64;
            if let Err(e) = stream.seek_to(t, COARSE_SEEK_MARGIN_SEC) {
                last_err = Some(e.to_string());
                break; // past EOF or unreadable — remaining columns stay 0
            }
        }

        mono[..lead].fill(0.0);
        let mut filled = lead;
        while filled < fft_size {
            let (interleaved, frames_read) = match stream.read(fft_size - filled) {
                Ok(r) => r,
                Err(e) => {
                    last_err = Some(e.to_string());
                    break;
                }
            };
            if frames_read == 0 {
                break; // EOF — the tail is zero-padded below
            }
            for (dst, v) in mono[filled..].iter_mut().zip(decoder::mix_to_mono(&interleaved, ch)) {
                *dst = v;
            }
            filled += frames_read;
        }

        // Nothing real in the window (EOF, or a read failure): leave it zero.
        if filled == lead {
            continue;
        }
        mono[filled..].fill(0.0);

        let dst = &mut output[col * n_freq_bins..(col + 1) * n_freq_bins];
        computer.compute(&mono, dst);
        with_audio += 1;
    }

    if with_audio == 0 && n_cols > 0 {
        return Err(last_err.unwrap_or_else(|| "no audio could be read for the coarse spectrogram".into()));
    }
    Ok(with_audio)
}

/// Decode + STFT one chunk, returning the encoded IPC blob.
///
/// Deliberately synchronous: it is pure CPU work (decode, FFT) with no await
/// points, and it runs on a blocking thread — see `get_spectrogram_chunk_range`,
/// the single command that reaches it.
fn compute_spectrogram_chunk(req: &SpectrogramChunkRequest) -> Result<Vec<u8>, String> {
    validate_stft_params(req.fft_size, req.hop_size)?;
    if !req.start_sec.is_finite() || req.start_sec < 0.0 || !req.duration_sec.is_finite() || req.duration_sec < 0.0 {
        return Err(format!(
            "start_sec and duration_sec must be finite and non-negative, got {} and {}",
            req.start_sec, req.duration_sec
        ));
    }
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
        // seeked it to column 0's window start, so the walk does not seek again.
        let mut stream = stream_pool::acquire(
            &req.path,
            coarse_first_window_sec(req.start_sec, req.fft_size, sample_rate),
            COARSE_SEEK_MARGIN_SEC,
        )
        .map_err(|e| e.to_string())?;
        coarse_columns(
            &mut stream, &mut output, n_cols, n_freq_bins,
            req.start_sec, req.hop_size, req.fft_size, sample_rate, false,
        )?;

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



// ── Chunk range (one forward pass) ────────────────────────────────

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

/// Compute a contiguous run of chunks, handing each encoded message (grid index
/// + blob) to `send` as it completes. An error from `send` (the receiver went
/// away) stops the walk.
pub fn compute_spectrogram_range(
    req: &SpectrogramRangeRequest,
    send: &mut dyn FnMut(Vec<u8>) -> Result<(), String>,
) -> Result<(), String> {
    validate_stft_params(req.fft_size, req.hop_size)?;
    if !req.chunk_duration.is_finite() || req.chunk_duration <= 0.0 {
        return Err(format!("chunk_duration must be positive and finite, got {}", req.chunk_duration));
    }
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
            send(build_range_message(req.first_chunk_index + i, bytes))?;
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
    let mut stream = stream_pool::acquire(
        &req.path,
        coarse_first_window_sec(chunk_start(0), req.fft_size, sample_rate),
        COARSE_SEEK_MARGIN_SEC,
    )
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
        // seek_first only for chunks after the first: acquire() already
        // positioned the stream at chunk 0's first window.
        coarse_columns(
            &mut stream, &mut output, n_cols, n_freq_bins,
            start_sec, req.hop_size, req.fft_size, sample_rate, i > 0,
        )?;
        let bytes = build_spectrogram_response(
            n_cols, n_freq_bins, start_sec, actual_duration_sec, sample_rate, &output,
        );
        send(build_range_message(req.first_chunk_index + i, bytes))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "spectrogram_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "spectrogram_bench.rs"]
mod bench;
