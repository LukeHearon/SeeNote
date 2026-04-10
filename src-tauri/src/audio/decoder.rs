use anyhow::{Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use std::fs::File;

pub struct FileInfo {
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

pub fn get_file_info(path: &str) -> Result<FileInfo> {
    let file = File::open(path).with_context(|| format!("Cannot open file: {path}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .context("Unsupported format")?;

    let format = probed.format;
    let track = format
        .default_track()
        .context("No default audio track found")?;

    let params = &track.codec_params;
    let sample_rate = params.sample_rate.unwrap_or(44100);
    let channels = params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(1);

    // Compute duration: n_frames (samples) / sample_rate
    let duration_secs = if let Some(n_frames) = params.n_frames {
        n_frames as f64 / sample_rate as f64
    } else {
        // Fallback: let VideoPlayer's onDurationChange fill this in
        0.0
    };

    Ok(FileInfo {
        duration_secs,
        sample_rate,
        channels,
    })
}

/// Decodes PCM samples for [start_sec, start_sec + duration_sec).
/// Returns mono f32 samples (averaged across all channels) and the sample rate.
///
/// ── Sample-accuracy contract ─────────────────────────────────────────────────
/// The returned buffer is aligned to `start_sec` at sample resolution:
///   output[0] corresponds to frame floor(start_sec * sample_rate)
///   output[i] corresponds to frame floor(start_sec * sample_rate) + i
///
/// This contract matters because:
///  - Adjacent chunks requested back-to-back must line up seamlessly in the
///    spectrogram (chunk-boundary gap bug, fixed 2026-04).
///  - Annotations created on the spectrogram must map to the exact same PCM
///    samples when exported.
///
/// ── Why the 500ms seek margin + packet-timestamp tracking ────────────────────
/// Symphonia's `format.seek(Accurate, ...)` is NOT sample-accurate for
/// compressed formats (MP3/AAC/Vorbis). It lands at the nearest decodable
/// frame boundary, which can be tens of milliseconds off — and critically,
/// the actual landing position is only visible via the first decoded
/// packet's timestamp, not the seek return value.
///
/// So we:
///   1. Seek to (start_sec - 0.5s) so we're guaranteed to land *before* the
///      desired position, even after a sloppy compressed-format seek.
///   2. Read the first packet's timestamp (via the track's time_base) to
///      learn exactly where the decoder actually landed, in absolute frames.
///   3. Walk forward frame-by-frame, dropping frames until we hit
///      `desired_start_frame`, then emit from there.
///
/// If the decoder somehow overshoots `desired_start_frame` (rare, but possible
/// with broken files), we prepend silence so the returned buffer still
/// starts at `start_sec`. This is preferable to returning a shorter buffer
/// because callers rely on `output[0] == start_sec`.
pub fn decode_audio_range(
    path: &str,
    start_sec: f64,
    duration_sec: f64,
) -> Result<(Vec<f32>, u32)> {
    let file = File::open(path).with_context(|| format!("Cannot open file: {path}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .context("Unsupported format")?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .context("No default audio track found")?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1);
    let time_base = track.codec_params.time_base;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("Failed to create decoder")?;

    // Seek with a safety margin before the target so that even if the seek
    // lands imprecisely (common with compressed formats like MP3/AAC/Vorbis),
    // we can skip forward to the exact requested position. See the
    // sample-accuracy contract at the top of this function for why this
    // matters and why 500ms is chosen (empirically covers all compressed
    // formats we've tested; cheap to decode and discard).
    let desired_start_frame = (start_sec * sample_rate as f64).round() as u64;
    let seek_margin_sec = 0.5; // 500ms margin — see doc comment above
    let seek_target = (start_sec - seek_margin_sec).max(0.0);

    if seek_target > 0.0 {
        let _ = format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from(seek_target),
                track_id: Some(track_id),
            },
        );
    }

    let target_samples = (duration_sec * sample_rate as f64).ceil() as usize;
    let mut output: Vec<f32> = Vec::with_capacity(target_samples);

    // Track absolute frame position using the first packet's timestamp so we
    // know exactly which decoded frames to skip vs. keep.
    let mut abs_frame: u64 = 0; // absolute frame counter from first packet
    let mut first_packet = true;

    'outer: loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        // On the first packet, determine our absolute position from its
        // timestamp so we can skip precisely to desired_start_frame.
        if first_packet {
            first_packet = false;
            if let Some(tb) = time_base {
                let pkt_time = tb.calc_time(packet.ts());
                let pkt_secs = pkt_time.seconds as f64 + pkt_time.frac;
                abs_frame = (pkt_secs * sample_rate as f64).round() as u64;
            } else {
                // No time_base: estimate position from where we asked to seek.
                // Without this, abs_frame would stay 0 and we'd skip far too
                // many frames when start_sec > 0.
                abs_frame = (seek_target * sample_rate as f64).round() as u64;
            }
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();

        // Mix down to mono: average all channels
        let n_ch = channels;
        let frames = samples.len() / n_ch;
        for frame in 0..frames {
            let cur = abs_frame + frame as u64;

            // Skip frames before the desired start
            if cur < desired_start_frame {
                continue;
            }

            // If the seek overshot past desired_start_frame, prepend silence
            // for the gap so the output length stays aligned with start_sec.
            if output.is_empty() && cur > desired_start_frame {
                let gap = (cur - desired_start_frame) as usize;
                output.resize(gap.min(target_samples), 0.0);
                if output.len() >= target_samples {
                    break 'outer;
                }
            }

            let mut mono = 0.0f32;
            for ch in 0..n_ch {
                mono += samples[frame * n_ch + ch];
            }
            output.push(mono / n_ch as f32);

            if output.len() >= target_samples {
                break 'outer;
            }
        }
        abs_frame += frames as u64;
    }

    Ok((output, sample_rate))
}
