use serde::{Deserialize, Serialize};
use crate::audio::{decoder, fft};

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

// ── Spectrogram chunk ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SpectrogramChunkRequest {
    pub path: String,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub fft_size: usize,
    pub hop_size: usize,
}

#[derive(Serialize)]
pub struct SpectrogramChunkResult {
    /// Flat column-major byte array: n_cols * n_freq_bins bytes.
    /// Each column has n_freq_bins entries (index 0 = highest freq bin, matching JS layout).
    pub data: Vec<u8>,
    pub n_cols: usize,
    pub n_freq_bins: usize,
    pub start_sec: f64,
    pub actual_duration_sec: f64,
    pub sample_rate: u32,
}

#[tauri::command]
pub async fn get_spectrogram_chunk(
    req: SpectrogramChunkRequest,
) -> Result<SpectrogramChunkResult, String> {
    let info = decoder::get_file_info(&req.path).map_err(|e| e.to_string())?;
    let sample_rate = info.sample_rate;
    let n_freq_bins = req.fft_size / 2;

    // For very large hop sizes (coarse overview tiers), use a sampled approach:
    // seek to each column position and decode one FFT window instead of
    // decoding the entire range and running a full STFT.
    if req.hop_size >= (sample_rate as usize) / 2 {
        let window_dur = req.fft_size as f64 / sample_rate as f64;
        let actual_end = (req.start_sec + req.duration_sec).min(info.duration_secs);
        let actual_duration_sec = actual_end - req.start_sec;
        let n_cols = ((actual_duration_sec * sample_rate as f64) / req.hop_size as f64).ceil() as usize;

        let mut output = vec![0u8; n_cols * n_freq_bins];
        for col in 0..n_cols {
            let t = req.start_sec + (col as f64 * req.hop_size as f64 / sample_rate as f64);
            if let Ok((samples, _)) = decoder::decode_audio_range(&req.path, t, window_dur) {
                if samples.len() >= req.fft_size {
                    let col_data = fft::compute_stft(&samples[..req.fft_size], req.fft_size, req.fft_size);
                    for bin in 0..n_freq_bins {
                        output[col * n_freq_bins + bin] = col_data.get(bin).copied().unwrap_or(0);
                    }
                }
            }
        }

        return Ok(SpectrogramChunkResult {
            data: output,
            n_cols,
            n_freq_bins,
            start_sec: req.start_sec,
            actual_duration_sec,
            sample_rate,
        });
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
    // ── Why actual_duration_sec uses req.duration_sec (not n_cols*hop/sr) ──
    // The renderer in Spectrogram.tsx maps canvas pixels → chunk columns via
    //   col = ((t - chunk.startSec) / chunk.actualDurationSec) * chunk.nCols
    // Because we decoded extra context, n_cols is SLIGHTLY larger than
    // (duration_sec * sample_rate / hop_size). If we reported
    // actual_duration_sec = n_cols * hop / sample_rate (which is > req.duration_sec),
    // pixels near the chunk's right edge would map to columns inside the
    // post-context region that belongs to the NEXT chunk's area — causing
    // the "gap" to manifest as a time-shifted stripe instead.
    // Reporting req.duration_sec keeps the mapping consistent with the
    // chunk boundary on the time axis, and the extra post-context columns
    // are simply unused (they exist only to give earlier columns full
    // Hanning windows).
    let half_window = req.fft_size / 2;
    let half_window_sec = half_window as f64 / sample_rate as f64;

    // Pre-context: decode up to half a window before the chunk start
    let pre_sec = req.start_sec.min(half_window_sec);
    let decode_start = req.start_sec - pre_sec;
    // Post-context: decode half a window past the chunk end
    let decode_duration = pre_sec + req.duration_sec + half_window_sec;

    let (raw_samples, _) =
        decoder::decode_audio_range(&req.path, decode_start, decode_duration)
            .map_err(|e| e.to_string())?;

    // Zero-pad the front when near the file start so column 0 is still centered
    // at start_sec even if we couldn't decode a full half-window of pre-context.
    let pre_samples_decoded = (pre_sec * sample_rate as f64).round() as usize;
    let zero_pad = half_window.saturating_sub(pre_samples_decoded);
    let mut samples = vec![0.0f32; zero_pad];
    samples.extend_from_slice(&raw_samples);

    let data = fft::compute_stft(&samples, req.fft_size, req.hop_size);
    let n_cols = if n_freq_bins > 0 { data.len() / n_freq_bins } else { 0 };

    // Use the requested duration (capped at file end) so that the column mapping
    // covers the full chunk.  With the extra context decoded above, n_cols is
    // large enough that no pixel within [start_sec, start_sec + duration] maps
    // to an out-of-bounds column index.
    let actual_duration_sec = req.duration_sec
        .min((info.duration_secs - req.start_sec).max(0.0));

    Ok(SpectrogramChunkResult {
        data,
        n_cols,
        n_freq_bins,
        start_sec: req.start_sec,
        actual_duration_sec,
        sample_rate,
    })
}

// ── Overview spectrogram ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OverviewRequest {
    pub path: String,
    pub n_columns: usize,
    pub fft_size: usize,
}

#[tauri::command]
pub async fn get_overview_spectrogram(
    req: OverviewRequest,
) -> Result<SpectrogramChunkResult, String> {
    // Get file duration first
    let info = decoder::get_file_info(&req.path).map_err(|e| e.to_string())?;
    let duration = info.duration_secs;
    let n_freq_bins = req.fft_size / 2;

    if duration <= 0.0 || req.n_columns == 0 {
        return Ok(SpectrogramChunkResult {
            data: Vec::new(),
            n_cols: 0,
            n_freq_bins,
            start_sec: 0.0,
            actual_duration_sec: 0.0,
            sample_rate: info.sample_rate,
        });
    }

    // Sampled overview: decode one FFT window at each evenly-spaced position.
    // This avoids loading the entire file into memory for long recordings.
    let window_dur = req.fft_size as f64 / info.sample_rate as f64;
    let mut output = vec![0u8; req.n_columns * n_freq_bins];

    for col in 0..req.n_columns {
        let t = (col as f64 / req.n_columns as f64) * duration;
        // Decode just one FFT window at this position
        if let Ok((samples, _)) = decoder::decode_audio_range(&req.path, t, window_dur) {
            if samples.len() >= req.fft_size {
                let col_data = fft::compute_stft(&samples[..req.fft_size], req.fft_size, req.fft_size);
                // col_data is exactly n_freq_bins bytes (one column)
                for bin in 0..n_freq_bins {
                    output[col * n_freq_bins + bin] = col_data.get(bin).copied().unwrap_or(0);
                }
            }
        }
    }

    Ok(SpectrogramChunkResult {
        data: output,
        n_cols: req.n_columns,
        n_freq_bins,
        start_sec: 0.0,
        actual_duration_sec: duration,
        sample_rate: info.sample_rate,
    })
}
