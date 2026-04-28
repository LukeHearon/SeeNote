use rustfft::{Fft, FftPlanner, num_complex::Complex};
use std::collections::HashMap;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

/// Per-`fft_size` cache: (FFT plan, Hann window coefficients).
/// Both are pure functions of `fft_size`, so we compute them once and reuse.
/// The `FftPlanner` and its output plans are `Send + Sync`, making a global
/// `Mutex<HashMap>` safe from any thread.
static FFT_CACHE: std::sync::OnceLock<Mutex<HashMap<usize, (Arc<dyn Fft<f32>>, Vec<f32>)>>> =
    std::sync::OnceLock::new();

fn get_fft_and_window(fft_size: usize) -> (Arc<dyn Fft<f32>>, Vec<f32>) {
    let cache = FFT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap();
    if let Some(entry) = map.get(&fft_size) {
        return entry.clone();
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);
    // Symmetric (N-1) Hann window — matches the JS frontend in audioProcessing.ts
    // which uses `(2 * PI * i) / (fftSize - 1)`. Do NOT switch to periodic (N)
    // form without updating the JS side to match.
    let window: Vec<f32> = (0..fft_size)
        .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / (fft_size - 1) as f32).cos()))
        .collect();
    let entry = (fft, window);
    map.insert(fft_size, entry.clone());
    entry
}

/// Runs STFT on `samples` and returns a flat Vec<u8> of shape [n_cols * n_freq_bins],
/// column-major. Each column stores bins from low-to-high frequency (index 0 = highest freq,
/// matching the JS layout: outputData[col * height + (height - 1 - bin)]).
///
/// Normalization (matches audioProcessing.ts):
///   mag_norm = mag * 4 / fft_size          (Hanning coherent amplitude gain → 0 dBFS = 0 dB)
///   val      = 20 * log10(mag_norm + 1e-6) (dBFS)
///   intensity = (val + 80) / 80 * 255      (80 dB range: -80 dBFS → 0, 0 dBFS → 255)
pub fn compute_stft(samples: &[f32], fft_size: usize, hop_size: usize) -> Vec<u8> {
    let n_freq_bins = fft_size / 2;

    if samples.len() < fft_size {
        return Vec::new();
    }

    let n_cols = (samples.len() - fft_size) / hop_size;
    if n_cols == 0 {
        return Vec::new();
    }

    let mut output = vec![0u8; n_cols * n_freq_bins];

    let (fft, window) = get_fft_and_window(fft_size);
    let mut scratch = vec![Complex::new(0.0f32, 0.0f32); fft.get_outofplace_scratch_len()];

    let mut buf_in = vec![Complex::new(0.0f32, 0.0f32); fft_size];
    let mut buf_out = vec![Complex::new(0.0f32, 0.0f32); fft_size];

    for col in 0..n_cols {
        let start = col * hop_size;

        // Apply Hanning window
        for i in 0..fft_size {
            buf_in[i] = Complex::new(samples[start + i] * window[i], 0.0);
        }

        fft.process_outofplace_with_scratch(&mut buf_in, &mut buf_out, &mut scratch);

        // Write magnitude to output column
        for bin in 0..n_freq_bins {
            let re = buf_out[bin].re;
            let im = buf_out[bin].im;
            let mag = (re * re + im * im).sqrt();

            // Match JS normalization exactly:
            // val = 20 * log10(mag + 1e-6)
            // intensity = (val + 60) * 4
            // Normalize by Hanning coherent amplitude gain (N/4) so 0 dBFS → 0 dB
            let mag_norm = mag * 4.0 / fft_size as f32;
            let val = 20.0 * (mag_norm + 1e-6f32).log10();
            // 80 dB display range: -80 dBFS → 0, 0 dBFS → 255
            let intensity = (val + 80.0) / 80.0 * 255.0;
            let intensity = intensity.clamp(0.0, 255.0) as u8;

            // JS layout: outputData[col * height + (height - 1 - bin)]
            output[col * n_freq_bins + (n_freq_bins - 1 - bin)] = intensity;
        }
    }

    output
}
