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
    let (samples, sample_rate) =
        decoder::decode_audio_range(&req.path, req.start_sec, req.duration_sec)
            .map_err(|e| e.to_string())?;

    let n_freq_bins = req.fft_size / 2;
    let data = fft::compute_stft(&samples, req.fft_size, req.hop_size);
    let n_cols = if n_freq_bins > 0 { data.len() / n_freq_bins } else { 0 };
    let actual_duration_sec = samples.len() as f64 / sample_rate as f64;

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
