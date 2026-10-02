use rustfft::{Fft, FftPlanner, num_complex::Complex};
use rayon::prelude::*;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

/// FFT plan and Hann window for one `fft_size`. Both are pure functions of the
/// size, so they are built once and shared; the window is an `Arc<[f32]>` so a
/// cache hit is a refcount bump rather than a copy of `fft_size` floats.
#[derive(Clone)]
struct Plan {
    fft: Arc<dyn Fft<f32>>,
    window: Arc<[f32]>,
}

/// The `FftPlanner` and its output plans are `Send + Sync`, making a global
/// `Mutex<HashMap>` safe from any thread.
static FFT_CACHE: std::sync::OnceLock<Mutex<HashMap<usize, Plan>>> = std::sync::OnceLock::new();

fn get_plan(fft_size: usize) -> Plan {
    let cache = FFT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = super::lock(cache);
    if let Some(entry) = map.get(&fft_size) {
        return entry.clone();
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);
    // Symmetric (N-1) Hann window — matches the JS frontend in audioProcessing.ts
    // which uses `(2 * PI * i) / (fftSize - 1)`. Do NOT switch to periodic (N)
    // form without updating the JS side to match.
    let window: Arc<[f32]> = (0..fft_size)
        .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / (fft_size - 1) as f32).cos()))
        .collect();
    let entry = Plan { fft, window };
    map.insert(fft_size, entry.clone());
    entry
}

/// dBFS = 20*log10(mag_norm) = 10*log10(mag_norm²), where mag_norm = mag*4/fft_size.
/// Pre-squaring the amplitude-normalization constant means we never take a sqrt:
/// mag_norm² = (re²+im²) * (4/fft_size)². The +1e-12 floor is the square of the
/// old +1e-6 amplitude floor, so silence still maps to −120 dBFS.
fn norm_sq_for(fft_size: usize) -> f32 {
    (4.0 / fft_size as f32).powi(2)
}

/// Reusable buffers for transforming one window at a time.
struct Scratch {
    buf_in: Vec<Complex<f32>>,
    buf_out: Vec<Complex<f32>>,
    fft_scratch: Vec<Complex<f32>>,
}

impl Scratch {
    fn new(fft: &dyn Fft<f32>, fft_size: usize) -> Self {
        Scratch {
            buf_in: vec![Complex::new(0.0, 0.0); fft_size],
            buf_out: vec![Complex::new(0.0, 0.0); fft_size],
            fft_scratch: vec![Complex::new(0.0, 0.0); fft.get_outofplace_scratch_len()],
        }
    }
}

/// Window `samples` (exactly `fft_size` of them), FFT, and write the quantized
/// dBFS magnitudes into `out_col` (`fft_size / 2` values, flipped layout — see
/// `compute_stft`). The one implementation behind both the parallel STFT and
/// the single-window path, so the two cannot drift apart.
fn transform_column(
    fft: &dyn Fft<f32>,
    window: &[f32],
    norm_sq: f32,
    samples: &[f32],
    scratch: &mut Scratch,
    out_col: &mut [u16],
) {
    let n_freq_bins = out_col.len();
    for (i, slot) in scratch.buf_in.iter_mut().enumerate() {
        *slot = Complex::new(samples[i] * window[i], 0.0);
    }

    fft.process_outofplace_with_scratch(
        &mut scratch.buf_in,
        &mut scratch.buf_out,
        &mut scratch.fft_scratch,
    );

    for bin in 0..n_freq_bins {
        let re = scratch.buf_out[bin].re;
        let im = scratch.buf_out[bin].im;
        let mag_norm_sq = (re * re + im * im) * norm_sq;

        let val = 10.0 * (mag_norm_sq + 1e-12f32).log10();
        // −140..0 dBFS mapped linearly to 0..65535
        let quantized = ((val + 140.0) / 140.0 * 65535.0).clamp(0.0, 65535.0) as u16;

        // JS layout: outputData[col * height + (height - 1 - bin)]
        out_col[n_freq_bins - 1 - bin] = quantized;
    }
}

/// Computes STFT columns one window at a time on the calling thread, reusing its
/// buffers across calls. For callers that produce a handful of columns from
/// separately read windows (the coarse spectrogram walk): `compute_stft` would
/// fan a single column out to rayon and allocate fresh scratch on every call.
pub struct ColumnComputer {
    plan: Plan,
    norm_sq: f32,
    scratch: Scratch,
    fft_size: usize,
}

impl ColumnComputer {
    /// `fft_size` must be at least 2.
    pub fn new(fft_size: usize) -> Self {
        let plan = get_plan(fft_size);
        let scratch = Scratch::new(plan.fft.as_ref(), fft_size);
        ColumnComputer { plan, norm_sq: norm_sq_for(fft_size), scratch, fft_size }
    }

    /// Transform `window` (`fft_size` samples) into `out_col` (`fft_size / 2`
    /// values); same layout and quantization as one column of `compute_stft`.
    pub fn compute(&mut self, window: &[f32], out_col: &mut [u16]) {
        debug_assert_eq!(window.len(), self.fft_size);
        debug_assert_eq!(out_col.len(), self.fft_size / 2);
        transform_column(
            self.plan.fft.as_ref(),
            &self.plan.window,
            self.norm_sq,
            window,
            &mut self.scratch,
            out_col,
        );
    }
}

/// Runs STFT on `samples` and returns a flat Vec<u16> of shape [n_cols * n_freq_bins],
/// column-major. Each column stores bins from low-to-high frequency (index 0 = highest freq,
/// matching the JS layout: outputData[col * height + (height - 1 - bin)]).
///
/// Each u16 encodes dBFS linearly: 0 → −140 dBFS, 65535 → 0 dBFS (~0.00214 dB/step).
/// Values below −140 dBFS clamp to 0; values above 0 dBFS clamp to 65535.
///
/// Normalization (computed without a sqrt — see `norm_sq_for`):
///   mag_norm  = mag * 4 / fft_size           (Hanning coherent amplitude gain → 0 dBFS = 0 dB)
///   val       = 20 * log10(mag_norm + 1e-6)
///             = 10 * log10(mag_norm² + 1e-12) (dBFS)  — the form actually evaluated
///
/// Returns an empty Vec when `fft_size < 2`, `hop_size == 0`, or there are fewer
/// than `fft_size` samples; callers validate those up front.
pub fn compute_stft(samples: &[f32], fft_size: usize, hop_size: usize) -> Vec<u16> {
    let n_freq_bins = fft_size / 2;

    if fft_size < 2 || hop_size == 0 || samples.len() < fft_size {
        return Vec::new();
    }

    // STFT col k uses samples[k*hop_size .. k*hop_size + fft_size], so the
    // largest valid k satisfies k*hop_size + fft_size <= samples.len().
    let n_cols = (samples.len() - fft_size) / hop_size + 1;

    let mut output = vec![0u16; n_cols * n_freq_bins];

    let plan = get_plan(fft_size);
    let norm_sq = norm_sq_for(fft_size);

    // Columns are fully independent: each reads samples[start..start+fft_size] and
    // writes only its own n_freq_bins slice of `output`. Parallelize across cores
    // (rayon) — the result is bit-for-bit identical regardless of scheduling.
    // for_each_init gives each worker thread its own reusable FFT scratch buffers,
    // so we never allocate per column.
    output
        .par_chunks_mut(n_freq_bins)
        .enumerate()
        .for_each_init(
            || Scratch::new(plan.fft.as_ref(), fft_size),
            |scratch, (col, out_col)| {
                let start = col * hop_size;
                transform_column(
                    plan.fft.as_ref(),
                    &plan.window,
                    norm_sq,
                    &samples[start..start + fft_size],
                    scratch,
                    out_col,
                );
            },
        );

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

    /// The single-window path must produce exactly what one column of the
    /// parallel STFT does.
    #[test]
    fn column_computer_matches_compute_stft() {
        let fft_size = 512usize;
        let n_freq_bins = fft_size / 2;
        let samples: Vec<f32> = (0..fft_size)
            .map(|i| 0.4 * (2.0 * PI * 1000.0 * i as f32 / 44100.0).sin())
            .collect();

        let expected = compute_stft(&samples, fft_size, fft_size);
        assert_eq!(expected.len(), n_freq_bins);

        let mut computer = ColumnComputer::new(fft_size);
        let mut out = vec![0u16; n_freq_bins];
        // Twice, to cover buffer reuse.
        for _ in 0..2 {
            computer.compute(&samples, &mut out);
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn degenerate_parameters_return_empty() {
        let samples = vec![0.0f32; 4096];
        assert!(compute_stft(&samples, 1024, 0).is_empty());
        assert!(compute_stft(&samples, 1, 256).is_empty());
        assert!(compute_stft(&samples, 0, 256).is_empty());
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
