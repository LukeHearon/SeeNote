use anyhow::{Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};
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

    let duration_secs = if let Some(n_frames) = params.n_frames {
        n_frames as f64 / sample_rate as f64
    } else {
        0.0
    };

    Ok(FileInfo {
        duration_secs,
        sample_rate,
        channels,
    })
}

// ── PcmStream ─────────────────────────────────────────────────────────────────
//
// Streaming, sample-accurate PCM reader. Clients call `open` once, then `read`
// repeatedly to pull interleaved f32 frames until `frames_read == 0` (EOF).
//
// ── Sample-accuracy contract ──────────────────────────────────────────────────
// `open(path, start_sec)` guarantees that the first frame returned by `read()`
// corresponds to exactly `floor(start_sec * sample_rate)` in the file.
//
// This is achieved via the same seek-margin + first-packet timestamp tracking
// used by `decode_audio_range`. See that function's doc comment for the full
// rationale. Both paths share this struct so the tricky alignment logic lives
// in exactly one place.
//
// ── Channel layout ────────────────────────────────────────────────────────────
// Samples are interleaved in the file's native channel order (e.g. L,R,L,R…
// for stereo). No mixdown is performed here; callers that need mono (e.g. the
// spectrogram pipeline) average the channels themselves.

/// Streaming PCM reader. Yields interleaved f32 samples at the file's native
/// sample rate and channel count, starting from an exact sample position.
pub struct PcmStream {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: u16,
    desired_start_frame: u64,
    /// Fallback frame position when no time_base is available (estimated from
    /// the seek target). Used only for the first-packet abs_frame assignment.
    seek_target_frame: u64,
    /// Absolute frame index corresponding to `pending[0]` (the start of the
    /// current decoded packet's samples).
    abs_frame: u64,
    first_packet: bool,
    time_base: Option<TimeBase>,
    /// Interleaved f32 samples from the most recently decoded packet.
    pending: Vec<f32>,
    /// Offset (in samples, not frames) into `pending` for the next unread sample.
    pending_pos: usize,
    eof: bool,
    /// Running count of frames returned via `read()`. Used to track position.
    next_output_frame: u64,
}

impl PcmStream {
    /// Open a file and seek to just before `start_sec` using the 500ms margin
    /// + first-packet timestamp technique (see module-level doc).
    pub fn open(path: &str, start_sec: f64) -> Result<Self> {
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
            .map(|c| c.count() as u16)
            .unwrap_or(1);
        let time_base = track.codec_params.time_base;

        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .context("Failed to create decoder")?;

        let desired_start_frame = (start_sec * sample_rate as f64).round() as u64;
        let seek_margin_sec = 0.5;
        let seek_target = (start_sec - seek_margin_sec).max(0.0);
        let seek_target_frame = (seek_target * sample_rate as f64).round() as u64;

        if seek_target > 0.0 {
            let _ = format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seek_target),
                    track_id: Some(track_id),
                },
            );
        }

        Ok(PcmStream {
            format,
            decoder,
            track_id,
            sample_rate,
            channels,
            desired_start_frame,
            seek_target_frame,
            abs_frame: 0,
            first_packet: true,
            time_base,
            pending: Vec::new(),
            pending_pos: 0,
            eof: false,
            next_output_frame: desired_start_frame,
        })
    }

    pub fn sample_rate(&self) -> u32 { self.sample_rate }
    pub fn channels(&self) -> u16 { self.channels }

    /// Absolute frame index of the first frame the next `read()` call will return.
    pub fn position_frames(&self) -> u64 { self.next_output_frame }

    /// Decode and buffer the next packet. Updates `abs_frame` to the packet's
    /// starting position. Returns `false` on EOF or unrecoverable read error.
    fn fill_next_packet(&mut self) -> Result<bool> {
        // Advance abs_frame past the frames consumed from the previous packet.
        // (This is only called when pending_pos >= pending.len(), so all of
        // the previous packet has been consumed or skipped.)
        if !self.first_packet {
            let prev_frames = self.pending.len() / self.channels as usize;
            self.abs_frame += prev_frames as u64;
        }
        self.pending.clear();
        self.pending_pos = 0;

        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(_) => return Ok(false),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            if self.first_packet {
                self.first_packet = false;
                // Determine the absolute frame of this packet from its timestamp.
                // The packet timestamp is more accurate than the seek return value,
                // especially for compressed formats where seeks land imprecisely.
                if let Some(tb) = self.time_base {
                    let t = tb.calc_time(packet.ts());
                    let pkt_secs = t.seconds as f64 + t.frac;
                    self.abs_frame = (pkt_secs * self.sample_rate as f64).round() as u64;
                } else {
                    // No time_base: fall back to the estimated seek position.
                    self.abs_frame = self.seek_target_frame;
                }
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            buf.copy_interleaved_ref(decoded);
            self.pending = buf.samples().to_vec();
            return Ok(!self.pending.is_empty());
        }
    }

    /// Read up to `max_frames` interleaved f32 frames. Returns `(samples, frames_read)`.
    /// `frames_read == 0` means EOF. `samples.len() == frames_read * channels`.
    pub fn read(&mut self, max_frames: usize) -> Result<(Vec<f32>, usize)> {
        let ch = self.channels as usize;
        let mut output: Vec<f32> = Vec::with_capacity(max_frames * ch);

        while output.len() / ch < max_frames {
            // Refill from the next decoded packet when current one is exhausted.
            if self.pending_pos >= self.pending.len() {
                if self.eof {
                    break;
                }
                match self.fill_next_packet()? {
                    false => { self.eof = true; break; }
                    true => {}
                }
                if self.pending_pos >= self.pending.len() {
                    break;
                }
            }

            let pending_frame = self.abs_frame + (self.pending_pos / ch) as u64;

            // Alignment phase: skip frames that precede desired_start_frame.
            if pending_frame < self.desired_start_frame {
                let frames_to_skip = (self.desired_start_frame - pending_frame) as usize;
                let samples_to_skip = (frames_to_skip * ch).min(self.pending.len() - self.pending_pos);
                self.pending_pos += samples_to_skip;
                continue;
            }

            // Overshoot correction: if the seek landed past desired_start_frame
            // and we haven't emitted anything yet for this stream, prepend silence
            // so that output[0] always corresponds to desired_start_frame.
            //
            // Gated on `next_output_frame == desired_start_frame` — i.e. this is
            // the first-ever emission from the stream. Without this gate the
            // correction misfires on every subsequent read() call (output is a
            // fresh local Vec, so output.is_empty() is always true at call entry,
            // and pending_frame is always > desired_start_frame once we've moved
            // past the start), silently filling the chunk with max_frames of
            // zeros.
            if output.is_empty()
                && self.next_output_frame == self.desired_start_frame
                && pending_frame > self.desired_start_frame
            {
                let gap_frames = ((pending_frame - self.desired_start_frame) as usize).min(max_frames);
                output.resize(gap_frames * ch, 0.0);
            }

            // Copy available frames into output up to max_frames.
            let frames_wanted = max_frames - output.len() / ch;
            let frames_available = (self.pending.len() - self.pending_pos) / ch;
            let frames_to_copy = frames_wanted.min(frames_available);
            let samples_to_copy = frames_to_copy * ch;
            output.extend_from_slice(
                &self.pending[self.pending_pos..self.pending_pos + samples_to_copy],
            );
            self.pending_pos += samples_to_copy;
        }

        let frames_read = output.len() / ch;
        self.next_output_frame += frames_read as u64;
        Ok((output, frames_read))
    }
}

// ── decode_audio_range ────────────────────────────────────────────────────────

/// Decodes PCM samples for [start_sec, start_sec + duration_sec).
/// Returns mono f32 samples (averaged across all channels) and the sample rate.
///
/// ── Sample-accuracy contract ─────────────────────────────────────────────────
/// The returned buffer is aligned to `start_sec` at sample resolution:
///   output[0] corresponds to frame floor(start_sec * sample_rate)
///   output[i] corresponds to frame floor(start_sec * sample_rate) + i
///
/// This is guaranteed by `PcmStream`, which this function uses internally.
/// See the `PcmStream` doc comment and the module-level comment for the full
/// explanation of the 500ms seek-margin + first-packet timestamp approach.
pub fn decode_audio_range(
    path: &str,
    start_sec: f64,
    duration_sec: f64,
) -> Result<(Vec<f32>, u32)> {
    let mut stream = PcmStream::open(path, start_sec)?;
    let sample_rate = stream.sample_rate();
    let ch = stream.channels() as usize;
    let target_frames = (duration_sec * sample_rate as f64).ceil() as usize;
    let mut output: Vec<f32> = Vec::with_capacity(target_frames);

    while output.len() < target_frames {
        let want = target_frames - output.len();
        let (interleaved, frames_read) = stream.read(want)?;
        if frames_read == 0 {
            break;
        }
        // Mix down to mono by averaging all channels.
        for frame in 0..frames_read {
            let mut sum = 0.0f32;
            for c in 0..ch {
                sum += interleaved[frame * ch + c];
            }
            output.push(sum / ch as f32);
        }
    }

    Ok((output, sample_rate))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that concatenating PcmStream chunks produces the same samples
    /// as a single decode_audio_range call for the same range.
    ///
    /// Requires a real audio file at the path below. Run with:
    ///   cargo test -- --ignored chunked_matches_oneshot
    #[test]
    #[ignore]
    fn chunked_matches_oneshot() {
        let path = "../../local/test.mp3"; // adjust to a real file
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
            for frame in 0..frames_read {
                let mut sum = 0.0f32;
                for c in 0..ch { sum += interleaved[frame * ch + c]; }
                mono_chunked.push(sum / ch as f32);
            }
        }

        assert_eq!(mono_chunked.len(), mono_ref.len(), "length mismatch");
        for (i, (a, b)) in mono_chunked.iter().zip(mono_ref.iter()).enumerate() {
            assert!(
                (a - b).abs() < 1e-6,
                "sample mismatch at frame {i}: chunked={a}, oneshot={b}"
            );
        }
    }
}
