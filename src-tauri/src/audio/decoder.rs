use anyhow::{Context, Result};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions, CODEC_ID_NULL_AUDIO};
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase, Timestamp};
use std::fs::File;
use std::sync::OnceLock;

pub struct FileInfo {
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Build (once, lazily) a `CodecRegistry` containing every codec Symphonia registers by default
/// for the `feature`s enabled in Cargo.toml, plus the Opus decoder.
///
/// Symphonia has no built-in Opus support — not even behind a feature flag — so WEBM/Matroska
/// files (which very commonly carry Opus audio) probe fine via the `mkv` demuxer but fail to
/// decode with "No decodable audio track found". `symphonia-adapter-libopus` wraps libopus
/// (statically built via its `bundled` cmake feature, mirroring how `git2` is vendored in this
/// Cargo.toml) to fill that gap. We start from Symphonia's own default registration function and
/// add exactly one more decoder, rather than hand-rolling the full default codec list ourselves.
fn codec_registry() -> &'static CodecRegistry {
    static REGISTRY: OnceLock<CodecRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut registry);
        registry.register_audio_decoder::<symphonia_adapter_libopus::OpusDecoder>();
        registry
    })
}

/// Find the first track in the container that has a decodable audio codec.
///
/// `format.default_track()` returns whatever the container marked as default — for
/// MP4/MKV with a video track that is often the video, not the audio. Building
/// an audio decoder against video codec params then fails silently upstream.
/// We iterate tracks and pick the first one that produces a working decoder.
fn find_audio_track(format: &dyn FormatReader) -> Option<&Track> {
    let codecs = codec_registry();
    format.tracks().iter().find(|t| {
        t.codec_params.as_ref().and_then(|cp| cp.audio()).is_some_and(|p| {
            p.codec != CODEC_ID_NULL_AUDIO
                && codecs.make_audio_decoder(p, &AudioDecoderOptions::default()).is_ok()
        })
    })
}

pub fn get_file_info(path: &str) -> Result<FileInfo> {
    let file = File::open(path).with_context(|| format!("Cannot open file: {path}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .context("Unsupported format")?;

    let (track_id, initial_sr, initial_channels, n_frames, delay, padding) = {
        let track = find_audio_track(format.as_ref())
            .context("No decodable audio track found")?;
        let audio_params = track.codec_params.as_ref().and_then(|cp| cp.audio());
        (
            track.id,
            audio_params.and_then(|p| p.sample_rate).unwrap_or(44100),
            audio_params
                .and_then(|p| p.channels.as_ref().map(|c| c.count() as u16))
                .unwrap_or(1),
            track.num_frames,
            track.delay.unwrap_or(0) as u64,
            track.padding.unwrap_or(0) as u64,
        )
    };

    // Matroska/WEBM tracks commonly leave `num_frames` unset — the per-block frame
    // count isn't tallied by the demuxer — but the Segment's own Duration element
    // (container-wide, not per-track) is exposed via `media_info()`. Used below as
    // the fallback when `num_frames` is unavailable.
    let media_info = *format.media_info();
    let container_duration_secs = media_info.duration.and_then(|dur| {
        let ts = Timestamp::try_from(dur.get()).ok()?;
        let time = media_info.time_base?.calc_time(ts)?;
        Some(time.as_secs_f64())
    });

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
        container_duration_secs.unwrap_or(0.0)
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
    let audio_params = track.codec_params.as_ref()?.audio()?;
    let mut decoder = codec_registry()
        .make_audio_decoder(audio_params, &AudioDecoderOptions::default())
        .ok()?;

    for _ in 0..16 {
        // next_packet() returns Ok(None) at EOF and Ok(Some(_))/Err(_) otherwise;
        // the double `?` propagates both "no more packets" and "read error" as None.
        let packet = format.next_packet().ok()??;
        if packet.track_id != track_id {
            continue;
        }
        if let Ok(decoded) = decoder.decode(&packet) {
            let spec = decoded.spec().clone();
            return Some((spec.rate(), spec.channels().count() as u16));
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
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    sample_rate: u32,
    channels: u16,
    /// Encoder delay (in container frames) declared by the codec — e.g. the
    /// LAME tag's enc_delay for MP3. These leading frames are inaudible
    /// padding and must be skipped so that audible-frame 0 lines up with the
    /// first real sample. Audible-frame N <-> container-frame N + delay_frames.
    delay_frames: u64,
    /// Track time base, kept so `seek_to` can convert a packet's pts to seconds
    /// the same way `open` does.
    time_base: Option<TimeBase>,
    /// `desired_start_frame` is stored in *container* frame coords (i.e.
    /// includes `delay_frames`) so the existing alignment logic that compares
    /// against `abs_frame` (also container-frame) works unchanged.
    desired_start_frame: u64,
    /// Absolute frame index corresponding to `pending[0]` (the start of the
    /// current decoded packet's samples).
    abs_frame: u64,
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

        let format = symphonia::default::get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .context("Unsupported format")?;

        // See find_audio_track: must not rely on default_track() for MP4/MKV,
        // where it may point at the video stream.
        let (track_id, initial_sr, initial_channels, time_base, delay) = {
            let track = find_audio_track(format.as_ref())
                .context("No decodable audio track found")?;
            let audio_params = track.codec_params.as_ref().and_then(|cp| cp.audio());
            (
                track.id,
                audio_params.and_then(|p| p.sample_rate).unwrap_or(44100),
                audio_params
                    .and_then(|p| p.channels.as_ref().map(|c| c.count() as u16))
                    .unwrap_or(1),
                track.time_base,
                track.delay.unwrap_or(0) as u64,
            )
        };

        let decoder = {
            let track = format
                .tracks()
                .iter()
                .find(|t| t.id == track_id)
                .ok_or_else(|| anyhow::anyhow!("Audio track {track_id} not found after probing"))?;
            let audio_params = track
                .codec_params
                .as_ref()
                .and_then(|cp| cp.audio())
                .ok_or_else(|| anyhow::anyhow!("Track {track_id} has no audio codec parameters"))?;
            codec_registry()
                .make_audio_decoder(audio_params, &AudioDecoderOptions::default())
                .context("Failed to create decoder")?
        };

        // Sanity-check the encoder delay. Values above ~4096 frames are
        // implausible (the largest known LAME delay is ~2257 at 44.1 kHz; AAC
        // gapless padding is typically ≤ 2048). A vastly larger value almost
        // certainly means a corrupt or unusual container and would cause us to
        // skip the first seconds of audio silently.
        const MAX_SANE_DELAY: u64 = 4096;
        if delay > MAX_SANE_DELAY {
            eprintln!(
                "PcmStream::open: encoder delay {delay} frames exceeds sanity bound \
                 {MAX_SANE_DELAY} — possibly corrupt container metadata for {path}"
            );
        }
        debug_assert!(
            delay <= MAX_SANE_DELAY,
            "encoder delay {delay} frames is implausibly large"
        );

        // Alignment state is set by seek_to below; these are placeholders that
        // are never observable (seek_to overwrites all of them, or errors).
        let mut stream = PcmStream {
            format,
            decoder,
            track_id,
            sample_rate: initial_sr,
            channels: initial_channels,
            delay_frames: delay,
            time_base,
            desired_start_frame: 0,
            abs_frame: 0,
            pending: Vec::new(),
            pending_pos: 0,
            eof: true,
            next_output_frame: 0,
        };
        // reader_is_fresh: nothing has been read from `format` yet, so it is
        // already positioned at the start of the stream.
        stream.reposition(start_sec, true)?;
        Ok(stream)
    }

    /// Reposition an already-open stream to `start_sec`, restoring the same
    /// sample-accuracy contract `open` establishes: the next `read()` returns
    /// the frame at exactly `floor(start_sec * sample_rate)`.
    ///
    /// This is the whole reason the seek/align phase is factored out of `open`.
    /// Sampling a file at scattered positions — which is what building a coarse
    /// overview column-by-column does — otherwise had to re-`open` per position,
    /// paying a full symphonia probe (and, for the alternative of reading
    /// forward, decoding every intervening sample just to throw it away).
    /// Reusing the format reader and decoder makes repositioning cost a seek.
    pub fn seek_to(&mut self, start_sec: f64) -> Result<()> {
        self.reposition(start_sec, false)
    }

    /// Shared seek + realignment. `reader_is_fresh` says the format reader has
    /// not yet yielded a packet, which is only true on the initial `open`.
    ///
    /// It matters because the seek below is skipped when the target rounds down
    /// to 0 (start_sec within the seek margin of the file start): a fresh reader
    /// is already there, but a reused one is wherever the last read left it, and
    /// skipping the seek would realign against a packet from the middle of the
    /// file — read() then sees the packet start as a huge overshoot and pads the
    /// result with silence.
    fn reposition(&mut self, start_sec: f64, reader_is_fresh: bool) -> Result<()> {
        // Validate before casting to u64 — a NaN, Infinity, or negative value
        // would silently wrap to a garbage frame index.
        if !start_sec.is_finite() || start_sec < 0.0 {
            return Err(anyhow::anyhow!(
                "start_sec must be a finite non-negative number, got {start_sec}"
            ));
        }

        // Seek using the *base* sample rate; symphonia's seek is in seconds,
        // so SBR doesn't affect the seek target calculation.
        //
        // Note on encoder delay: symphonia's seek interprets time in container
        // frames (gapless mode is off). The delay is small relative to the
        // 0.5s seek margin (typical MP3 LAME delay ≈ 26ms at 44.1 kHz), so
        // seeking to (start_sec - 0.5) container-seconds reliably lands before
        // the desired audible position. The alignment phase in read() skips the
        // remaining frames, including any encoder padding when start_sec is 0.
        let seek_margin_sec = 0.5;
        let seek_target = (start_sec - seek_margin_sec).max(0.0);

        if seek_target > 0.0 || !reader_is_fresh {
            let _ = self.format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::try_from_secs_f64(seek_target).unwrap_or(Time::ZERO),
                    track_id: Some(self.track_id),
                },
            );
        }
        // The next packet is discontinuous with the last one decoded, so the
        // decoder's inter-packet state (e.g. MP3's bit reservoir / overlap-add
        // tail) must be dropped or the first columns after a seek decode from
        // stale history.
        self.decoder.reset();

        // ── Eager first-packet decode to discover the real post-SBR spec ────
        // See get_file_info for the full SBR rationale. We need the actual
        // decoded sample rate before returning so the caller reports the
        // correct rate to the frontend. We also need it so abs_frame /
        // desired_start_frame math is in the same frame-rate as the samples
        // we'll emit.
        self.pending.clear();
        self.pending_pos = 0;
        let mut first_abs_frame: u64 = 0;
        let mut eof = true; // flipped to false once we decode a packet

        for _ in 0..16 {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) | Err(_) => break,
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let spec = decoded.spec().clone();
            self.sample_rate = spec.rate();
            self.channels = spec.channels().count() as u16;

            // Packet pts is in base units (time_base is based on the container's
            // timescale, pre-SBR). Convert to seconds, then to frames at the
            // real (post-SBR) sample_rate. Fall back to the seek target if the
            // conversion overflows (implausible in practice, but calc_time can
            // return None).
            first_abs_frame = self
                .time_base
                .and_then(|tb| tb.calc_time(packet.pts))
                .map(|t| (t.as_secs_f64() * self.sample_rate as f64).round() as u64)
                .unwrap_or_else(|| (seek_target * self.sample_rate as f64).round() as u64);

            decoded.copy_to_vec_interleaved::<f32>(&mut self.pending);
            eof = false;
            break;
        }

        if eof {
            return Err(anyhow::anyhow!(
                "No decodable audio packets found within 16 packets of {start_sec}s"
            ));
        }

        let start_sec_frames = start_sec * self.sample_rate as f64;
        if start_sec_frames >= u64::MAX as f64 {
            return Err(anyhow::anyhow!(
                "start_sec {start_sec} is too large to represent as a frame index"
            ));
        }

        // desired_start_frame is in container-frame coords (audible + delay)
        // so the alignment phase in read() skips both the seek-overshoot and
        // any encoder delay padding when start_sec falls in or near the delay
        // region. start_frame_audible is the same position expressed in
        // audible-frame coords, which is what we report to the frontend.
        let start_frame_audible = start_sec_frames.round() as u64;
        self.desired_start_frame = start_frame_audible + self.delay_frames;
        self.abs_frame = first_abs_frame;
        self.eof = false;
        // next_output_frame tracks position in *audible* frames (what the
        // frontend treats as time = frame / sample_rate).
        self.next_output_frame = start_frame_audible;
        Ok(())
    }

    pub fn sample_rate(&self) -> u32 { self.sample_rate }
    pub fn channels(&self) -> u16 { self.channels }

    /// Absolute frame index of the first frame the next `read()` call will return.
    pub fn position_frames(&self) -> u64 { self.next_output_frame }

    /// Decode and buffer the next packet. Updates `abs_frame` to the packet's
    /// starting position. Returns `false` on EOF or unrecoverable read error.
    fn fill_next_packet(&mut self) -> Result<bool> {
        // Advance abs_frame past the *full* previous packet before clearing it.
        // Using pending.len() / channels (the full packet size) is correct here
        // because abs_frame tracks the start of the *next* packet, not the
        // consumed-up-to position. pending_pos (the read cursor) is not used
        // because that would drift abs_frame by the alignment-skipped head on
        // the first packet.
        let prev_frames = self.pending.len() / self.channels as usize;
        self.abs_frame += prev_frames as u64;
        self.pending.clear();
        self.pending_pos = 0;

        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(false),
                Err(_) => return Ok(false),
            };

            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue,
            };

            // `copy_to_vec_interleaved` resizes `pending` to fit exactly and
            // copies in one call; since `pending` is cleared (not dropped)
            // above, its capacity is reused across packets so steady-state
            // decoding stays allocation-free here, same as before.
            decoded.copy_to_vec_interleaved::<f32>(&mut self.pending);
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
                // fill_next_packet resets pending_pos to 0 and only returns
                // true when it produced a non-empty packet, so pending is
                // guaranteed non-empty here.
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
///
/// ── EOF / short-read behavior ────────────────────────────────────────────────
/// If the file ends before `duration_sec` seconds of audio have been decoded,
/// the function returns whatever samples were available **without padding**.
/// The caller must treat `output.len() < ceil(duration_sec * sample_rate)` as
/// a normal end-of-file condition, not an error. No silence is appended.
pub fn decode_audio_range(
    path: &str,
    start_sec: f64,
    duration_sec: f64,
) -> Result<(Vec<f32>, u32)> {
    // PcmStream::open validates start_sec, but catch bad duration here too so
    // the target_frames cast below is always safe.
    if !duration_sec.is_finite() || duration_sec < 0.0 {
        return Err(anyhow::anyhow!(
            "duration_sec must be a finite non-negative number, got {duration_sec}"
        ));
    }
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
    ) -> PcmStream {
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

        PcmStream {
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

    /// Write a mono 16-bit WAV whose frame i holds sample value i, and return
    /// its path. Values wrap at 30000 to stay inside i16.
    fn write_ramp_wav(name: &str, sample_rate: u32, n_frames: usize) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let data_bytes = (n_frames * 2) as u32;
        let byte_rate = sample_rate * 2;
        let mut wav: Vec<u8> = Vec::with_capacity(44 + data_bytes as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());   // PCM
        wav.extend_from_slice(&1u16.to_le_bytes());   // mono
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());   // block align
        wav.extend_from_slice(&16u16.to_le_bytes());  // bits per sample
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        for i in 0..n_frames {
            wav.extend_from_slice(&((i % 30000) as i16).to_le_bytes());
        }
        std::fs::write(&path, wav).expect("write ramp wav");
        path
    }

    /// f32 value symphonia yields for ramp frame `i`.
    fn ramp_value(i: usize) -> f32 {
        (i % 30000) as f32 / 32768.0
    }

    #[test]
    fn seek_to_lands_on_the_exact_frame() {
        let sr = 8000u32;
        let path = write_ramp_wav("seenote_seek_to_exact.wav", sr, 40_000);
        let mut stream = PcmStream::open(path.to_str().unwrap(), 0.0).expect("open");

        // Forward, backward, and back to the start: every reposition must land
        // on floor(start_sec * sample_rate), the same guarantee open() gives.
        for start_sec in [0.0, 2.5, 1.0, 4.999, 0.0, 3.25] {
            stream.seek_to(start_sec).expect("seek_to");
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
            walked.seek_to(t).expect("seek_to");
            let (from_walk, n_walk) = walked.read(64).expect("read");

            let mut fresh = PcmStream::open(p, t).expect("open");
            let (from_open, n_open) = fresh.read(64).expect("read");

            assert_eq!(n_walk, n_open, "frame count at {t}s");
            assert_eq!(from_walk, from_open, "samples at {t}s");
        }
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
}

#[cfg(test)]
mod seek_bench {
    use super::*;
    use std::time::Instant;

    /// Records the seek characteristic the coarse spectrogram path is built on:
    /// walking a single stream FORWARD is cheap and its total cost is roughly
    /// flat in the number of stops (the container scan resumes where it left
    /// off), whereas re-opening per position restarts the scan from byte 0 and
    /// costs time proportional to the depth of each seek.
    ///
    /// Not a unit test — it needs a long real file, so it is #[ignore]d:
    ///   SEEK_BENCH_FILE=/path/to/long.mp3 \
    ///     cargo test --release seek_bench -- --ignored --nocapture
    ///
    /// Measured on a 1GB / 49.7h MP3 (Apple silicon, local SSD):
    ///   re-open + read, 20 scattered positions   122 ms/column
    ///   forward seek_to, 20 positions            249 ms TOTAL
    ///   forward seek_to, 100 positions           283 ms TOTAL
    ///   sequential decode of the whole file      ~48 s
    #[test]
    #[ignore]
    fn forward_seek_is_cheaper_than_reopen() {
        let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
        let info = get_file_info(&path).expect("info");
        println!("file: dur={:.0}s sr={}", info.duration_secs, info.sample_rate);

        let n = 20;
        let t = Instant::now();
        for i in 0..n {
            let target = info.duration_secs * (i as f64 / n as f64);
            let mut s = PcmStream::open(&path, target).expect("open");
            let _ = s.read(2048).expect("read");
        }
        let reopen = t.elapsed();
        println!("{n} re-open+read: {reopen:?} total, {:?}/column", reopen / n as u32);

        for n in [20usize, 100] {
            let mut s = PcmStream::open(&path, 0.0).expect("open");
            let t = Instant::now();
            for i in 0..n {
                let target = info.duration_secs * (i as f64 / n as f64);
                s.seek_to(target).expect("seek_to");
                let _ = s.read(2048).expect("read");
            }
            let total = t.elapsed();
            println!("{n} forward seek_to on one stream: {total:?} total, {:?}/column",
                     total / n as u32);
        }
    }
}
