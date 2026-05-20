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

/// Runs STFT on `samples` and returns a flat Vec<u16> of shape [n_cols * n_freq_bins],
/// column-major. Each column stores bins from low-to-high frequency (index 0 = highest freq,
/// matching the JS layout: outputData[col * height + (height - 1 - bin)]).
///
/// Each u16 encodes dBFS linearly: 0 → −140 dBFS, 65535 → 0 dBFS (~0.00214 dB/step).
/// Values below −140 dBFS clamp to 0; values above 0 dBFS clamp to 65535.
///
/// Normalization:
///   mag_norm = mag * 4 / fft_size   (Hanning coherent amplitude gain → 0 dBFS = 0 dB)
///   val      = 20 * log10(mag_norm + 1e-6)  (dBFS)
pub fn compute_stft(samples: &[f32], fft_size: usize, hop_size: usize) -> Vec<u16> {
    let n_freq_bins = fft_size / 2;

    if samples.len() < fft_size {
        return Vec::new();
    }

    // STFT col k uses samples[k*hop_size .. k*hop_size + fft_size], so the
    // largest valid k satisfies k*hop_size + fft_size <= samples.len().
    let n_cols = (samples.len() - fft_size) / hop_size + 1;

    let mut output = vec![0u16; n_cols * n_freq_bins];

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

            let mag_norm = mag * 4.0 / fft_size as f32;
            let val = 20.0 * (mag_norm + 1e-6f32).log10();
            // −140..0 dBFS mapped linearly to 0..65535
            let quantized = ((val + 140.0) / 140.0 * 65535.0).clamp(0.0, 65535.0) as u16;

            // JS layout: outputData[col * height + (height - 1 - bin)]
            output[col * n_freq_bins + (n_freq_bins - 1 - bin)] = quantized;
        }
    }

    output
}
