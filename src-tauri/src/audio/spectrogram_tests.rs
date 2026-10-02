use super::*;

/// A mono WAV whose content varies over time, so a column computed at the
/// wrong position is detectable: a tone whose frequency rises over the file,
/// giving every position a distinct spectrum.
fn write_test_wav(name: &str, sample_rate: u32, secs: f64) -> std::path::PathBuf {
    let n_frames = (sample_rate as f64 * secs) as usize;
    crate::audio::wav::write_test_wav(name, sample_rate, 1, n_frames, |i, _| {
        let t = i as f64 / sample_rate as f64;
        let freq = 200.0 + 60.0 * t;
        ((2.0 * std::f64::consts::PI * freq * t).sin() * 20000.0) as i16
    })
}

/// The shared forward walk must produce byte-identical chunks to computing
/// each one on its own stream — otherwise coarse tiers would disagree with
/// themselves depending on how the renderer happened to batch requests.
#[test]
fn range_walk_matches_per_chunk_computation() {
    let _guard = crate::audio::stream_pool::test_guard();
    let sr = 8000u32;
    let path = write_test_wav("seenote_range_walk.wav", sr, 40.0);
    let p = path.to_str().unwrap().to_string();
    let fft_size = 256usize;
    let hop_size = 8000usize; // 1s hop: comfortably in the coarse path
    let chunk_duration = 8.0;
    let n_chunks = 4u32;

    // Per-chunk reference: a fresh stream for each chunk.
    let mut expected: Vec<Vec<u8>> = Vec::new();
    for i in 0..n_chunks {
        expected.push(
            compute_spectrogram_chunk(&SpectrogramChunkRequest {
                path: p.clone(),
                start_sec: i as f64 * chunk_duration,
                duration_sec: chunk_duration,
                fft_size,
                hop_size,
            })
            .expect("chunk"),
        );
    }

    // The range walk reuses one stream across all four.
    let range = SpectrogramRangeRequest {
        path: p.clone(),
        first_chunk_index: 0,
        n_chunks,
        chunk_duration,
        fft_size,
        hop_size,
    };
    let info = decoder::get_file_info(&p).expect("info");
    let sample_rate = info.sample_rate;
    let n_freq_bins = fft_size / 2;
    let mut stream = decoder::PcmStream::open(&p, 0.0).expect("open");
    for i in 0..n_chunks {
        let start_sec = i as f64 * chunk_duration;
        let (n_cols, actual_duration_sec) = coarse_geometry(
            start_sec, chunk_duration, info.duration_secs, hop_size, sample_rate,
        );
        let mut output = vec![0u16; n_cols * n_freq_bins];
        coarse_columns(
            &mut stream, &mut output, n_cols, n_freq_bins,
            start_sec, hop_size, fft_size, sample_rate, i > 0,
        ).expect("coarse walk");
        let got = build_spectrogram_response(
            n_cols, n_freq_bins, start_sec, actual_duration_sec, sample_rate, &output,
        );
        assert_eq!(
            got, expected[i as usize],
            "chunk {i} from the shared walk differs from its standalone computation"
        );
    }
    let _ = range.n_chunks; // request shape is exercised by the command itself
    let _ = std::fs::remove_file(&path);
}

#[test]
fn range_message_carries_its_grid_index() {
    let _guard = crate::audio::stream_pool::test_guard();
    let msg = build_range_message(7, vec![1, 2, 3]);
    assert_eq!(u32::from_le_bytes(msg[0..4].try_into().unwrap()), 7);
    assert_eq!(&msg[4..], &[1, 2, 3]);
}

#[test]
fn coarse_geometry_keeps_the_column_rate_exact() {
    let _guard = crate::audio::stream_pool::test_guard();
    let sr = 48000u32;
    let hop = 96000usize; // 2s
    let (n_cols, dur) = coarse_geometry(0.0, 60.0, 600.0, hop, sr);
    // n_cols / dur must equal the true cps so columns land on real centres.
    assert!(((n_cols as f64 / dur) - (sr as f64 / hop as f64)).abs() < 1e-9);
    // A chunk running past EOF is truncated to what the file holds.
    let (n_cols_eof, _) = coarse_geometry(590.0, 60.0, 600.0, hop, sr);
    assert!(n_cols_eof < n_cols);
}
