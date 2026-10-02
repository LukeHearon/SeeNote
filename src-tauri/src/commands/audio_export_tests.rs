use super::*;

/// A WAV whose samples encode their own position (frame and channel), so a
/// wrong start offset or wrong length in the exported range is directly
/// visible in the sample values, not just their count.
fn write_ramp_wav(name: &str, sample_rate: u32, channels: u16, n_frames: usize) -> std::path::PathBuf {
    let ch = channels as usize;
    wav::write_test_wav(name, sample_rate, channels, n_frames, |frame, c| ((frame * ch + c) % 30000) as i16)
}

fn read_wav_i16(path: &std::path::Path) -> (u32, u16, Vec<i16>) {
    let bytes = std::fs::read(path).expect("read exported wav");
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
    let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    let data_bytes = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
    let samples = bytes[44..44 + data_bytes]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    (sample_rate, channels, samples)
}

#[test]
fn exports_the_requested_range_preserving_channels() {
    let sr = 8000u32;
    let channels = 2u16;
    let src = write_ramp_wav("seenote_export_src.wav", sr, channels, sr as usize * 4); // 4s

    let out = std::env::temp_dir().join("seenote_export_out.wav");
    export_audio_range_blocking(src.to_str().unwrap(), 1.0, 2.0, out.to_str().unwrap())
        .expect("export");

    let (out_sr, out_channels, samples) = read_wav_i16(&out);
    assert_eq!(out_sr, sr);
    assert_eq!(out_channels, channels);
    // 2s at 8kHz stereo = 16000 frames * 2 channels.
    assert_eq!(samples.len(), 16000 * 2);
    // First exported frame is source frame 8000 (start_sec=1.0 * sr):
    // channel 0 value is (8000*2 + 0) % 30000.
    assert_eq!(samples[0], ((8000 * 2) % 30000) as i16);
    assert_eq!(samples[1], ((8000 * 2 + 1) % 30000) as i16);

    let _ = std::fs::remove_file(&src);
    let _ = std::fs::remove_file(&out);
}

#[test]
fn errors_on_an_unsupported_extension_without_ffmpeg() {
    // Only meaningful when ffmpeg isn't resolvable in this test environment;
    // skip rather than false-fail on a machine that happens to have it.
    if crate::audio::ffmpeg_stream::detected_ffmpeg_path().is_some() {
        return;
    }
    let sr = 8000u32;
    let src = write_ramp_wav("seenote_export_src2.wav", sr, 1, sr as usize);
    let out = std::env::temp_dir().join("seenote_export_out.mp3");
    let result = export_audio_range_blocking(src.to_str().unwrap(), 0.0, 1.0, out.to_str().unwrap());
    assert!(result.is_err());
    let _ = std::fs::remove_file(&src);
}

/// The frontend's readPcmChunk decodes this layout by hand (tauriCommands.ts);
/// this pins the header shape and byte order build_pcm_chunk_response promises.
#[test]
fn pcm_chunk_response_round_trips() {
    let samples: Vec<f32> = vec![0.5, -0.25, 1.0, -1.0, 0.0, 0.125];
    let bytes = build_pcm_chunk_response(3, 12345, &samples);

    assert_eq!(bytes.len(), 12 + samples.len() * 4);
    assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 3);
    assert_eq!(u64::from_le_bytes(bytes[4..12].try_into().unwrap()), 12345);
    for (i, &expected) in samples.iter().enumerate() {
        let off = 12 + i * 4;
        let got = f32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        assert_eq!(got, expected);
    }
}
