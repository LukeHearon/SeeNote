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

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: pull the quantized value at logical bin `bin` (where bin 0 is DC,
    /// bin n_freq_bins-1 is Nyquist-adjacent) from column `col` of the flat output.
    fn bin_at(output: &[u16], col: usize, bin: usize, n_freq_bins: usize) -> u16 {
        output[col * n_freq_bins + (n_freq_bins - 1 - bin)]
    }

    /// argmax over logical bins (DC=0 .. n_freq_bins-1) in a given column.
    fn argmax_bin(output: &[u16], col: usize, n_freq_bins: usize) -> usize {
        let mut best_bin = 0usize;
        let mut best_val = 0u16;
        for bin in 0..n_freq_bins {
            let v = bin_at(output, col, bin, n_freq_bins);
            if v > best_val {
                best_val = v;
                best_bin = bin;
            }
        }
        best_bin
    }

    /// Output dimensions follow `n_cols * n_freq_bins` where
    ///   n_cols = (n_samples - fft_size) / hop_size + 1
    ///   n_freq_bins = fft_size / 2
    #[test]
    fn output_dimensions_match_formula() {
        let fft_size = 1024usize;
        let hop_size = 256usize;
        // Pick n_samples so that (n_samples - fft_size) is an exact multiple of hop_size
        // and also tests the truncation case below.
        let n_samples = fft_size + hop_size * 7; // 7 hops after the first frame
        let samples = vec![0.0f32; n_samples];

        let out = compute_stft(&samples, fft_size, hop_size);

        let n_freq_bins = fft_size / 2;
        let expected_cols = (n_samples - fft_size) / hop_size + 1;
        assert_eq!(expected_cols, 8, "sanity: 1 base frame + 7 hops");
        assert_eq!(out.len(), expected_cols * n_freq_bins);

        // Now with a non-multiple n_samples, the trailing partial frame is dropped.
        let n_samples2 = fft_size + hop_size * 7 + (hop_size / 2);
        let samples2 = vec![0.0f32; n_samples2];
        let out2 = compute_stft(&samples2, fft_size, hop_size);
        let expected_cols2 = (n_samples2 - fft_size) / hop_size + 1;
        assert_eq!(expected_cols2, 8);
        assert_eq!(out2.len(), expected_cols2 * n_freq_bins);
    }

    /// If `samples.len() < fft_size` the function returns an empty Vec.
    #[test]
    fn too_few_samples_returns_empty() {
        let fft_size = 1024usize;
        let hop_size = 256usize;
        let samples = vec![0.1f32; fft_size - 1];
        let out = compute_stft(&samples, fft_size, hop_size);
        assert!(out.is_empty());
    }

    /// All-zero input: the quantizer maps anything below −140 dBFS to 0.
    /// log10(0 + 1e-6) = -6 → val = -120 dBFS, which is above the -140 floor
    /// and quantizes to ((−120 + 140) / 140) * 65535 ≈ 9362. So zeros do NOT
    /// produce a literal 0 — they produce a constant noise-floor value across
    /// every bin. This test locks that in.
    #[test]
    fn silence_produces_constant_noise_floor() {
        let fft_size = 1024usize;
        let hop_size = 256usize;
        let n_samples = fft_size + hop_size * 3;
        let samples = vec![0.0f32; n_samples];

        let out = compute_stft(&samples, fft_size, hop_size);
        assert!(!out.is_empty());

        // Compute the expected noise-floor quantized value from the formula.
        // mag = 0, mag_norm = 0, val = 20 * log10(1e-6) = -120 dBFS
        // quantized = ((-120 + 140) / 140) * 65535
        let expected = (((-120.0_f32 + 140.0) / 140.0) * 65535.0) as u16;

        for (i, &v) in out.iter().enumerate() {
            // Allow ±1 due to floating-point rounding in the quantizer
            let diff = (v as i32 - expected as i32).abs();
            assert!(
                diff <= 1,
                "index {i}: expected ~{expected}, got {v} (diff {diff})"
            );
        }
    }

    /// DC input (constant non-zero): a windowed constant signal concentrates
    /// energy in bin 0 (DC) of the FFT output. With the flipped layout, that
    /// is stored at offset (n_freq_bins - 1) within each column.
    #[test]
    fn dc_input_concentrates_in_bin_zero() {
        let fft_size = 1024usize;
        let hop_size = 256usize;
        let n_freq_bins = fft_size / 2;
        let n_samples = fft_size + hop_size * 3;
        let samples = vec![0.5f32; n_samples];

        let out = compute_stft(&samples, fft_size, hop_size);

        for col in 0..4 {
            let max_bin = argmax_bin(&out, col, n_freq_bins);
            assert_eq!(
                max_bin, 0,
                "col {col}: DC should be the max bin, got bin {max_bin}"
            );

            // DC should be much larger than any nearby high-frequency bin.
            let dc_val = bin_at(&out, col, 0, n_freq_bins);
            let hi_val = bin_at(&out, col, n_freq_bins - 1, n_freq_bins);
            assert!(
                dc_val > hi_val + 1000,
                "col {col}: dc_val={dc_val} should dominate hi_val={hi_val}"
            );
        }
    }

    /// Sine wave at exactly a bin-center frequency: that bin should be the
    /// argmax in every column. Uses sample_rate=44100, fft_size=1024, bin=50,
    /// giving a tone at 50 * 44100 / 1024 ≈ 2153 Hz.
    #[test]
    fn single_bin_sine_peaks_at_expected_bin() {
        let sample_rate = 44100.0f32;
        let fft_size = 1024usize;
        let hop_size = 256usize;
        let n_freq_bins = fft_size / 2;
        let target_bin = 50usize;
        let freq_hz = target_bin as f32 * sample_rate / fft_size as f32;

        let n_samples = fft_size + hop_size * 5;
        let samples: Vec<f32> = (0..n_samples)
            .map(|i| (2.0 * PI * freq_hz * i as f32 / sample_rate).sin())
            .collect();

        let out = compute_stft(&samples, fft_size, hop_size);
        let n_cols = (n_samples - fft_size) / hop_size + 1;
        assert_eq!(out.len(), n_cols * n_freq_bins);

        for col in 0..n_cols {
            let max_bin = argmax_bin(&out, col, n_freq_bins);
            assert_eq!(
                max_bin, target_bin,
                "col {col}: expected peak at bin {target_bin}, got bin {max_bin}"
            );
        }
    }

    /// Reproducibility: running compute_stft twice on the same input must
    /// produce bit-identical output. No hidden RNG / no caching artifacts.
    #[test]
    fn reproducible_output() {
        let fft_size = 512usize;
        let hop_size = 128usize;
        let n_samples = fft_size + hop_size * 9;
        let samples: Vec<f32> = (0..n_samples)
            .map(|i| {
                0.3 * (2.0 * PI * 440.0 * i as f32 / 44100.0).sin()
                    + 0.2 * (2.0 * PI * 1234.0 * i as f32 / 44100.0).sin()
            })
            .collect();

        let a = compute_stft(&samples, fft_size, hop_size);
        let b = compute_stft(&samples, fft_size, hop_size);
        assert_eq!(a, b, "STFT output must be bit-identical across runs");
    }
}
