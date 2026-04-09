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
/// Returns mono f32 samples (channel 0 only, or averaged if stereo) and the sample rate.
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

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("Failed to create decoder")?;

    // Seek to start position
    if start_sec > 0.0 {
        let _ = format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from(start_sec),
                track_id: Some(track_id),
            },
        );
    }

    let target_samples = (duration_sec * sample_rate as f64).ceil() as usize;
    let mut output: Vec<f32> = Vec::with_capacity(target_samples);

    'outer: loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
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
            let mut mono = 0.0f32;
            for ch in 0..n_ch {
                mono += samples[frame * n_ch + ch];
            }
            output.push(mono / n_ch as f32);

            if output.len() >= target_samples {
                break 'outer;
            }
        }
    }

    Ok((output, sample_rate))
}
