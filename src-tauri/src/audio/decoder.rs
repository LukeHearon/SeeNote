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

/// Find the first track in the container that has a decodable audio codec.
///
/// `format.default_track()` returns whatever the container marked as default — for
/// MP4/MKV with a video track that is often the video, not the audio. Building
/// an audio decoder against video codec params then fails silently upstream.
/// We iterate tracks and pick the first one that produces a working decoder.
fn find_audio_track(format: &dyn FormatReader) -> Option<&symphonia::core::formats::Track> {
    let codecs = symphonia::default::get_codecs();
    format.tracks().iter().find(|t| {
        t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL
            && codecs
                .make(&t.codec_params, &DecoderOptions::default())
                .is_ok()
    })
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

    let mut format = probed.format;
    let (track_id, initial_sr, initial_channels, n_frames, delay, padding) = {
        let track = find_audio_track(format.as_ref())
            .context("No decodable audio track found")?;
        let p = &track.codec_params;
        (
            track.id,
            p.sample_rate.unwrap_or(44100),
            p.channels.map(|c| c.count() as u16).unwrap_or(1),
            p.n_frames,
            p.delay.unwrap_or(0) as u64,
            p.padding.unwrap_or(0) as u64,
        )
    };

    // ── SBR / post-decode sample-rate discovery ────────────────────────────────
    // HE-AAC (common inside MP4) uses Spectral Band Replication (SBR). The
    // AudioSpecificConfig carried in codec_params reports the BASE sample rate
    // (e.g. 24 kHz), but the decoder outputs samples at 2× that rate (48 kHz)
    // once SBR is applied. Reporting the base rate to the frontend makes Web
    // Audio treat the real-48 kHz buffer as 24 kHz, playing it back at half
    // speed — audio sounds pitched down an octave and the stream appears to
    // "run long" past the playhead.
    //
    // To get the truth we have to *decode a packet* and read `decoded.spec()`.
    // We do a one-packet peek here in get_file_info, and PcmStream::open does
    // the same at open time so the streaming path uses the real rate too.
    let (real_sr, real_channels) =
        probe_decoded_spec(format.as_mut(), track_id).unwrap_or((initial_sr, initial_channels));

    // n_frames is reported in *base-rate* frames (same units as time_base), so
    // dividing by initial_sr gives correct seconds regardless of SBR.
    //
    // Subtract encoder delay and padding (LAME header for MP3, equivalents for
    // other lossy formats) so the reported duration reflects audible content
    // only — matching what Audacity and most players show.
    let duration_secs = if let Some(n) = n_frames {
        n.saturating_sub(delay + padding) as f64 / initial_sr as f64
    } else {
        0.0
    };

    Ok(FileInfo {
        duration_secs,
        sample_rate: real_sr,
        channels: real_channels,
    })
}

/// Decode one packet from `track_id` and return its real post-SBR spec.
/// Leaves the format reader consumed by that packet — only used for one-shot
/// inspection by `get_file_info`, not for streaming.
fn probe_decoded_spec(
    format: &mut dyn FormatReader,
    track_id: u32,
) -> Option<(u32, u16)> {
    let track = format.tracks().iter().find(|t| t.id == track_id)?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;

    for _ in 0..16 {
        let packet = format.next_packet().ok()?;
        if packet.track_id() != track_id {
            continue;
        }
        if let Ok(decoded) = decoder.decode(&packet) {
            let spec = *decoded.spec();
            return Some((spec.rate, spec.channels.count() as u16));
        }
    }
    None
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
    /// Encoder delay (in container frames) declared by the codec — e.g. the
    /// LAME tag's enc_delay for MP3. These leading frames are inaudible
    /// padding and must be skipped so that audible-frame 0 lines up with the
    /// first real sample. Audible-frame N <-> container-frame N + delay_frames.
    delay_frames: u64,
    /// `desired_start_frame` is stored in *container* frame coords (i.e.
    /// includes `delay_frames`) so the existing alignment logic that compares
    /// against `abs_frame` (also container-frame) works unchanged.
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
        // See find_audio_track: must not rely on default_track() for MP4/MKV,
        // where it may point at the video stream.
        let (track_id, initial_sr, initial_channels, time_base, delay) = {
            let track = find_audio_track(format.as_ref())
                .context("No decodable audio track found")?;
            (
                track.id,
                track.codec_params.sample_rate.unwrap_or(44100),
                track
                    .codec_params
                    .channels
                    .map(|c| c.count() as u16)
                    .unwrap_or(1),
                track.codec_params.time_base,
                track.codec_params.delay.unwrap_or(0) as u64,
            )
        };

        let mut decoder = {
            let track = format.tracks().iter().find(|t| t.id == track_id).unwrap();
            symphonia::default::get_codecs()
                .make(&track.codec_params, &DecoderOptions::default())
                .context("Failed to create decoder")?
        };

        // Seek using the *base* sample rate; symphonia's seek is in seconds,
        // so SBR doesn't affect the seek target calculation.
        //
        // Note on encoder delay: symphonia's seek interprets time in container
        // frames (gapless mode is off). The delay is small relative to the
        // 0.5s seek margin (typical MP3 LAME delay ≈ 26ms at 44.1 kHz), so
        // seeking to (start_sec - 0.5) container-seconds reliably lands before
        // the desired audible position. The alignment phase below skips the
        // remaining frames, including any encoder padding when start_sec is 0.
        let seek_margin_sec = 0.5;
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

        // ── Eager first-packet decode to discover the real post-SBR spec ────
        // See get_file_info for the full SBR rationale. We need the actual
        // decoded sample rate BEFORE returning so the caller reports the
        // correct rate to the frontend. We also need it so abs_frame /
        // desired_start_frame math is in the same frame-rate as the samples
        // we'll emit.
        let mut pending: Vec<f32> = Vec::new();
        let mut first_abs_frame: u64 = 0;
        let mut sample_rate = initial_sr;
        let mut channels = initial_channels;
        let mut eof = true; // flipped to false once we decode a packet

        for _ in 0..16 {
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
            let spec = *decoded.spec();
            sample_rate = spec.rate;
            channels = spec.channels.count() as u16;

            // Packet ts is in base units (time_base is based on the container's
            // timescale, pre-SBR). Convert to seconds, then to frames at the
            // real (post-SBR) sample_rate.
            if let Some(tb) = time_base {
                let t = tb.calc_time(packet.ts());
                let pkt_secs = t.seconds as f64 + t.frac;
                first_abs_frame = (pkt_secs * sample_rate as f64).round() as u64;
            } else {
                first_abs_frame = (seek_target * sample_rate as f64).round() as u64;
            }

            let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            buf.copy_interleaved_ref(decoded);
            pending = buf.samples().to_vec();
            eof = false;
            break;
        }

        // desired_start_frame is in container-frame coords (audible + delay)
        // so the alignment phase in read() skips both the seek-overshoot and
        // any encoder delay padding when start_sec falls in or near the delay
        // region. start_frame_audible is the same position expressed in
        // audible-frame coords, which is what we report to the frontend.
        let start_frame_audible = (start_sec * sample_rate as f64).round() as u64;
        let desired_start_frame = start_frame_audible + delay;
        let seek_target_frame = (seek_target * sample_rate as f64).round() as u64;

        Ok(PcmStream {
            format,
            decoder,
            track_id,
            sample_rate,
            channels,
            delay_frames: delay,
            desired_start_frame,
            seek_target_frame,
            abs_frame: first_abs_frame,
            // first_packet is already consumed — fill_next_packet must NOT
            // re-assign abs_frame from packet.ts() on its next call, and
            // SHOULD advance abs_frame by prev_frames like any other packet.
            first_packet: false,
            time_base,
            pending,
            pending_pos: 0,
            eof,
            // next_output_frame tracks position in *audible* frames (what the
            // frontend treats as time = frame / sample_rate).
            next_output_frame: start_frame_audible,
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
            // Gated on `next_output_frame + delay_frames == desired_start_frame` —
            // i.e. this is the first-ever emission from the stream.
            // (next_output_frame is in audible coords; desired_start_frame is in
            // container coords; they differ by delay_frames.) Without this gate
            // the correction misfires on every subsequent read() call (output is
            // a fresh local Vec, so output.is_empty() is always true at call
            // entry, and pending_frame is always > desired_start_frame once
            // we've moved past the start), silently filling the chunk with
            // max_frames of zeros.
            if output.is_empty()
                && self.next_output_frame + self.delay_frames == self.desired_start_frame
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
