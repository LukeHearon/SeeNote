use super::*;
use crate::audio::wav::write_ramp_wav;

/// Verifies that concatenating PcmStream chunks produces the same samples
/// as a single decode_audio_range call for the same range.
///
/// Requires a real audio file at the path below. Run with:
///   cargo test -- --ignored chunked_matches_oneshot
#[test]
#[ignore]
fn chunked_matches_oneshot() {
    // Relative to the crate manifest dir (src-tauri), which is cargo's cwd
    // for tests — so this is <repo>/local/test.mp3.
    let path = "../local/test.mp3";
    let start_sec = 1.0f64;
    let duration_sec = 4.0f64;

    let (mono_ref, sr) = decode_audio_range(path, start_sec, duration_sec)
        .expect("decode_audio_range failed");

    let mut stream = PcmStream::open(path, start_sec).expect("PcmStream::open failed");
    assert_eq!(stream.sample_rate(), sr);

    let ch = stream.channels() as usize;
    let chunk_frames = (sr as usize) / 2; // 500ms chunks
    let target_frames = mono_ref.len();
    let mut mono_chunked: Vec<f32> = Vec::with_capacity(target_frames);

    loop {
        let want = (target_frames - mono_chunked.len()).min(chunk_frames);
        if want == 0 { break; }
        let (interleaved, frames_read) = stream.read(want).expect("read failed");
        if frames_read == 0 { break; }
        mono_chunked.extend(mix_to_mono(&interleaved, ch));
    }

    assert_eq!(mono_chunked.len(), mono_ref.len(), "length mismatch");
    for (i, (a, b)) in mono_chunked.iter().zip(mono_ref.iter()).enumerate() {
        assert!(
            (a - b).abs() < 1e-6,
            "sample mismatch at frame {i}: chunked={a}, oneshot={b}"
        );
    }
}

// ── Encoder-delay gate unit tests ─────────────────────────────────────────
//
// These tests exercise the overshoot-correction gate in PcmStream::read()
// using a synthetic PcmStream built entirely from in-memory data, so they
// run without any real audio file and are always-on (not #[ignore]).
//
// The gate condition is:
//   output.is_empty()
//   && next_output_frame + delay_frames == desired_start_frame   ← "first call"
//   && pending_frame > desired_start_frame                       ← "seek overshot"
//
// delay=0 path: desired_start_frame == next_output_frame (start_sec == 0),
//               seek overshoot by `gap` frames → gap frames of silence prepended.
//
// delay>0 path: desired_start_frame == start_frame_audible + delay,
//               same overshoot scenario.

/// Build a minimal PcmStream whose first pending[] buffer starts at
/// `abs_frame_start` and contains `n_frames` frames of a known ramp signal
/// (sample value == frame_index as f32), with `delay_frames` and
/// `desired_start_frame` configured so the gate fires when
/// `pending_frame > desired_start_frame`.
fn make_test_stream(
    delay_frames: u64,
    desired_start_frame: u64,
    abs_frame_start: u64,
    n_frames: usize,
) -> SymphoniaStream {
    use symphonia::core::formats::TrackType;

    let channels = 1u16;
    let sample_rate = 44100u32;

    // Build a ramp: sample[i] = (abs_frame_start + i) as f32 so we can
    // verify which frames ended up in the output.
    let pending: Vec<f32> = (0..n_frames)
        .map(|i| (abs_frame_start + i as u64) as f32)
        .collect();

    // next_output_frame = desired_start_frame - delay_frames  (audible coords)
    let next_output_frame = desired_start_frame.saturating_sub(delay_frames);

    // A minimal valid WAV (44 bytes, no data) used purely to obtain a real
    // FormatReader + AudioDecoder pair to satisfy the struct's fields. The
    // stream is pre-filled via `pending` and `eof: true`, so neither
    // `next_packet` nor `decode` is ever called in these tests.
    static SILENT_WAV: &[u8] = &[
        b'R', b'I', b'F', b'F', 36,0,0,0, b'W', b'A', b'V', b'E',
        b'f', b'm', b't', b' ', 16,0,0,0,  1,0, 1,0,
        0x44,0xAC,0,0, 0x88,0x58,1,0, 2,0, 16,0,
        b'd', b'a', b't', b'a',  0,0,0,0,
    ];

    fn open_silent_wav() -> Box<dyn FormatReader> {
        use symphonia::core::io::ReadOnlySource;
        let cursor = std::io::Cursor::new(SILENT_WAV);
        let mss = symphonia::core::io::MediaSourceStream::new(
            Box::new(ReadOnlySource::new(cursor)),
            Default::default(),
        );
        let mut hint = symphonia::core::formats::probe::Hint::new();
        hint.with_extension("wav");
        symphonia::default::get_probe()
            .probe(&hint, mss, Default::default(), Default::default())
            .expect("probe silent wav")
    }

    SymphoniaStream {
        // These fields are never exercised by read() in the pure in-memory path
        // because pending is pre-filled and we won't call fill_next_packet.
        format: open_silent_wav(),
        decoder: {
            let fmt = open_silent_wav();
            let track = fmt.default_track(TrackType::Audio).expect("wav has a track");
            let audio_params = track
                .codec_params
                .as_ref()
                .and_then(|cp| cp.audio())
                .expect("wav track has audio codec params");
            codec_registry()
                .make_audio_decoder(audio_params, &AudioDecoderOptions::default())
                .expect("make pcm decoder")
        },
        track_id: 0,
        sample_rate,
        channels,
        delay_frames,
        time_base: None,
        desired_start_frame,
        abs_frame: abs_frame_start,
        pending,
        pending_pos: 0,
        eof: true, // pre-filled; fill_next_packet will see eof and stop
        next_output_frame,
    }
}

// ── seek_to: the sample-accuracy contract survives repositioning ─────────
//
// These use a real WAV on disk rather than the in-memory PcmStream builder
// above, because seek_to's whole job is the format-reader seek + realignment
// that the synthetic stream skips. A 16-bit ramp makes every frame
// self-identifying: frame i holds i, so a misaligned seek is visible in the
// first sample read.


/// f32 value symphonia yields for ramp frame `i`.
fn ramp_value(i: usize) -> f32 {
    (i % 30000) as f32 / 32768.0
}

/// The FileInfo cache keys on the file's mtime and length, so a file
/// rewritten on disk must be re-probed rather than served stale — the whole
/// reason it validates a stamp instead of expiring on a timer.
#[test]
fn file_info_is_cached_but_reprobed_when_the_file_changes() {
    let sr = 8000u32;
    let path = write_ramp_wav("seenote_info_cache.wav", sr, 16_000); // 2s
    let p = path.to_str().unwrap();

    let first = get_file_info(p).expect("info");
    assert!((first.duration_secs - 2.0).abs() < 0.01, "got {}", first.duration_secs);

    // A repeat call must agree (served from cache or not, the answer is the same).
    let cached = get_file_info(p).expect("info");
    assert_eq!(cached.duration_secs, first.duration_secs);
    assert_eq!(cached.sample_rate, first.sample_rate);

    // Rewrite with a different length. mtime resolution can be coarse, so
    // the length change is what this asserts on — either half of the stamp
    // is enough to invalidate.
    let path2 = write_ramp_wav("seenote_info_cache.wav", sr, 48_000); // 6s
    assert_eq!(path2, path);
    let after = get_file_info(p).expect("info");
    assert!(
        (after.duration_secs - 6.0).abs() < 0.01,
        "stale duration {} after rewrite",
        after.duration_secs
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn seek_to_lands_on_the_exact_frame() {
    let sr = 8000u32;
    let path = write_ramp_wav("seenote_seek_to_exact.wav", sr, 40_000);
    let mut stream = PcmStream::open(path.to_str().unwrap(), 0.0).expect("open");

    // Forward, backward, and back to the start: every reposition must land
    // on round(start_sec * sample_rate), the same guarantee open() gives.
    for start_sec in [0.0, 2.5, 1.0, 4.999, 0.0, 3.25] {
        stream.seek_to(start_sec, DEFAULT_SEEK_MARGIN_SEC).expect("seek_to");
        let expected_frame = (start_sec * sr as f64) as usize;
        assert_eq!(
            stream.position_frames(),
            expected_frame as u64,
            "position after seek to {start_sec}s"
        );
        let (samples, frames_read) = stream.read(4).expect("read");
        assert_eq!(frames_read, 4, "short read after seek to {start_sec}s");
        for (i, &s) in samples.iter().enumerate() {
            assert!(
                (s - ramp_value(expected_frame + i)).abs() < 1e-6,
                "seek to {start_sec}s, frame +{i}: got {s}, want {}",
                ramp_value(expected_frame + i)
            );
        }
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn seek_to_with_a_small_margin_still_lands_exactly() {
    // The coarse spectrogram walk trades margin for throughput; the landing
    // position must stay exact regardless of how much slack it asks for.
    let sr = 8000u32;
    let path = write_ramp_wav("seenote_seek_to_margin.wav", sr, 40_000);
    let mut stream = PcmStream::open(path.to_str().unwrap(), 0.0).expect("open");

    for margin in [0.0, 0.01, 0.05, 0.5] {
        for start_sec in [0.0, 1.234, 3.75] {
            stream.seek_to(start_sec, margin).expect("seek");
            let expected_frame = (start_sec * sr as f64) as usize;
            let (samples, _) = stream.read(4).expect("read");
            for (i, &v) in samples.iter().enumerate() {
                assert!(
                    (v - ramp_value(expected_frame + i)).abs() < 1e-6,
                    "margin {margin}, seek {start_sec}s, frame +{i}: got {v}"
                );
            }
        }
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn skip_to_lands_exactly_and_refuses_to_go_backwards() {
    let sr = 8000u32;
    let path = write_ramp_wav("seenote_skip_to.wav", sr, 40_000);
    let mut stream = PcmStream::open(path.to_str().unwrap(), 0.0).expect("open");

    // Forward skips of the size the stream pool uses (sub-margin gaps).
    for start_sec in [0.05, 0.2, 0.75, 3.0] {
        stream.skip_to(start_sec).expect("skip_to");
        let expected_frame = (start_sec * sr as f64).round() as usize;
        assert_eq!(stream.position_frames(), expected_frame as u64);
        let (samples, _) = stream.read(4).expect("read");
        for (i, &v) in samples.iter().enumerate() {
            assert!(
                (v - ramp_value(expected_frame + i)).abs() < 1e-6,
                "skip to {start_sec}s frame +{i}: got {v}"
            );
        }
    }

    // Backwards is not reachable by reading; the caller must open or seek.
    assert!(stream.skip_to(0.1).is_err());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn seek_to_matches_a_fresh_open_at_the_same_position() {
    let sr = 8000u32;
    let path = write_ramp_wav("seenote_seek_to_vs_open.wav", sr, 40_000);
    let p = path.to_str().unwrap();

    // The coarse spectrogram path replaced per-column re-opens with seek_to
    // on one stream; the two must produce identical audio or coarse tiers
    // would disagree with fine tiers about what is at a given time.
    let mut walked = PcmStream::open(p, 0.0).expect("open");
    for col in 0..8 {
        let t = col as f64 * 0.6;
        walked.seek_to(t, DEFAULT_SEEK_MARGIN_SEC).expect("seek_to");
        let (from_walk, n_walk) = walked.read(64).expect("read");

        let mut fresh = PcmStream::open(p, t).expect("open");
        let (from_open, n_open) = fresh.read(64).expect("read");

        assert_eq!(n_walk, n_open, "frame count at {t}s");
        assert_eq!(from_walk, from_open, "samples at {t}s");
    }
    let _ = std::fs::remove_file(&path);
}

/// The same guarantee, on a real MP3.
///
/// The WAV version above proves the alignment arithmetic, but WAV seeking is
/// trivial — position is a byte offset. MP3 is where it can actually go
/// wrong: no seek index, a container seek that lands wherever it lands, an
/// encoder delay to skip, and a decoder that must be reset across the seek.
/// Playback reuses pooled streams via `seek_to`/`skip_to` (see
/// `audio::stream_pool` and `commands::audio::start_pcm_stream`), so a
/// reused stream disagreeing with a fresh open by even one frame would put
/// the audio at the wrong time under the playhead.
///
/// #[ignore]d like `chunked_matches_oneshot`: needs a fixture at
/// `<repo>/local/test.mp3` (gitignored). Run with:
///   cargo test -- --ignored seek_to_matches_a_fresh_open_on_mp3
#[test]
#[ignore]
fn seek_to_matches_a_fresh_open_on_mp3() {
    let p = "../local/test.mp3";
    let info = get_file_info(p).expect("get_file_info");
    // Sample across the file, staying clear of the very end so every probe
    // has a full read available.
    let last = (info.duration_secs - 1.0).max(0.0);

    let mut walked = PcmStream::open(p, 0.0).expect("open");
    for i in 0..8 {
        let t = last * (i as f64 / 8.0);
        walked.seek_to(t, DEFAULT_SEEK_MARGIN_SEC).expect("seek_to");
        let (from_walk, n_walk) = walked.read(4096).expect("read");

        let mut fresh = PcmStream::open(p, t).expect("open");
        let (from_open, n_open) = fresh.read(4096).expect("read");

        assert_eq!(
            walked.position_frames(), fresh.position_frames(),
            "position after reading at {t}s",
        );
        assert_eq!(n_walk, n_open, "frame count at {t}s");
        assert_eq!(from_walk, from_open, "samples at {t}s");
    }
}

/// Forward `skip_to` — the other way the pool advances a reused stream, used
/// when the target is already within the seek margin — must land identically.
///
/// #[ignore]d: needs the same `<repo>/local/test.mp3` fixture.
#[test]
#[ignore]
fn skip_to_matches_a_fresh_open_on_mp3() {
    let p = "../local/test.mp3";

    let mut walked = PcmStream::open(p, 0.0).expect("open");
    // Sub-margin forward hops, which is what stream_pool::acquire turns into
    // skip_to rather than a backward seek.
    for i in 1..8 {
        let t = i as f64 * 0.25;
        walked.skip_to(t).expect("skip_to");
        let (from_skip, n_skip) = walked.read(4096).expect("read");

        let mut fresh = PcmStream::open(p, t).expect("open");
        let (from_open, n_open) = fresh.read(4096).expect("read");

        assert_eq!(n_skip, n_open, "frame count at {t}s");
        assert_eq!(from_skip, from_open, "samples at {t}s");
    }
}

/// After a lost packet the next one's timestamp says where it really
/// starts; the difference is what must be padded with silence.
#[test]
fn resync_pads_only_a_plausible_forward_gap() {
    let sr = 44100;
    // Packet claims to start 1152 frames after where the running count is.
    assert_eq!(resync_gap_frames(101_152, 100_000, sr), 1152);
    // In step, or behind (timestamp jitter, rewinds): nothing to pad.
    assert_eq!(resync_gap_frames(100_000, 100_000, sr), 0);
    assert_eq!(resync_gap_frames(99_000, 100_000, sr), 0);
    // A wild timestamp must not allocate minutes of silence.
    assert_eq!(resync_gap_frames(100_000 + sr as u64 * 11, 100_000, sr), 0);
}

#[test]
fn mix_to_mono_averages_channels() {
    let stereo = [1.0f32, 3.0, -1.0, 1.0];
    assert_eq!(mix_to_mono(&stereo, 2).collect::<Vec<_>>(), vec![2.0, 0.0]);
    // Mono passes through; a zero channel count is clamped, not a panic.
    assert_eq!(mix_to_mono(&[0.5, 0.25], 1).collect::<Vec<_>>(), vec![0.5, 0.25]);
    assert_eq!(mix_to_mono(&[0.5, 0.25], 0).collect::<Vec<_>>(), vec![0.5, 0.25]);
}

/// A seek past the end is an error, not a silent fallback to whatever the
/// reader was last positioned at, and the stream stays usable afterwards.
#[test]
fn seek_past_the_end_is_an_error() {
    let sr = 8000u32;
    let path = write_ramp_wav("seenote_seek_past_end.wav", sr, 16_000); // 2s
    let mut stream = PcmStream::open(path.to_str().unwrap(), 0.0).expect("open");
    assert!(stream.seek_to(60.0, DEFAULT_SEEK_MARGIN_SEC).is_err());
    stream.seek_to(1.0, DEFAULT_SEEK_MARGIN_SEC).expect("seek back in range");
    let (_, n) = stream.read(4).expect("read");
    assert_eq!(n, 4);
    let _ = std::fs::remove_file(&path);
}

/// delay=0, seek overshoot of 10 frames:
/// The gate should prepend 10 silence frames, then copy real audio.
#[test]
fn encoder_delay_zero_with_overshoot() {
    let gap = 10usize;
    let desired: u64 = 100; // desired_start_frame in container coords
    let abs_start: u64 = desired + gap as u64; // seek landed 10 frames past desired

    // delay=0 → desired_start_frame == next_output_frame (start_sec=desired/sr)
    let mut stream = make_test_stream(0, desired, abs_start, 50);

    let (samples, frames_read) = stream.read(60).expect("read");
    // First gap frames should be silence (0.0)
    for i in 0..gap {
        assert_eq!(
            samples[i], 0.0,
            "frame {i} should be silence (overshoot padding)"
        );
    }
    // Remaining frames should be the ramp starting at abs_start
    for i in gap..frames_read {
        let expected = (abs_start + (i - gap) as u64) as f32;
        assert_eq!(
            samples[i], expected,
            "frame {i}: expected ramp value {expected}, got {}",
            samples[i]
        );
    }
    // Total: gap silence + 50 ramp frames, capped at max_frames=60
    assert_eq!(frames_read, gap + 50);
}

/// delay>0 (e.g. MP3-like delay of 576 frames), seek exactly at desired:
/// No overshoot — no silence should be prepended, and the gate should NOT
/// fire. All returned samples should be real audio from the ramp.
#[test]
fn encoder_delay_nonzero_no_overshoot() {
    let delay: u64 = 576;
    let start_audible: u64 = 44100; // 1 second into audible content
    let desired_start_frame = start_audible + delay; // container coords

    // seek lands exactly at desired_start_frame (no overshoot)
    let abs_start: u64 = desired_start_frame;
    let n_frames = 100usize;
    let mut stream = make_test_stream(delay, desired_start_frame, abs_start, n_frames);

    let (samples, frames_read) = stream.read(n_frames).expect("read");
    assert_eq!(frames_read, n_frames);
    for i in 0..frames_read {
        let expected = (abs_start + i as u64) as f32;
        assert_eq!(
            samples[i], expected,
            "frame {i}: expected {expected}, got {}",
            samples[i]
        );
    }
}

/// delay>0, seek overshoot of 5 frames:
/// Gate fires; 5 frames of silence prepended, then ramp.
#[test]
fn encoder_delay_nonzero_with_overshoot() {
    let delay: u64 = 576;
    let start_audible: u64 = 44100;
    let desired_start_frame = start_audible + delay;

    let gap = 5usize;
    let abs_start: u64 = desired_start_frame + gap as u64;
    let n_frames = 50usize;
    let mut stream = make_test_stream(delay, desired_start_frame, abs_start, n_frames);

    let (samples, frames_read) = stream.read(60).expect("read");
    for i in 0..gap {
        assert_eq!(samples[i], 0.0, "frame {i} should be silence");
    }
    for i in gap..frames_read {
        let expected = (abs_start + (i - gap) as u64) as f32;
        assert_eq!(samples[i], expected, "frame {i}: expected {expected}");
    }
    assert_eq!(frames_read, gap + n_frames);
}
