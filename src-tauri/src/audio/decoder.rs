use anyhow::{Context, Result};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions, CODEC_ID_NULL_AUDIO};
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::errors::{Error as SymphoniaError, SeekErrorKind};
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase, Timestamp};
use std::collections::HashMap;
use std::fs::File;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Clone, Copy)]
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

/// Extensions with no symphonia decoder, routed instead to the `ffmpeg_stream`
/// fallback backend (see that module for why).
fn is_ffmpeg_ext(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("wma")
    )
}

// ── FileInfo cache ────────────────────────────────────────────────────────────
//
// Probing a file is not cheap on either backend: symphonia opens it, probes the
// container, and decodes up to 16 packets to discover the post-SBR spec, while
// the ffmpeg path spawns `ffprobe` (~107ms measured on a `.wma`). Yet the
// duration/rate/channels it returns are needed at the top of essentially every
// command — `compute_spectrogram_chunk` calls it once per chunk, and
// `FfmpegStream::open` calls it again on the way to opening the stream, so a
// single cold `.wma` chunk paid for two ffprobe spawns before decoding a sample.
//
// Entries are validated against the file's mtime and length rather than expired
// on a timer, so a file rewritten on disk is re-probed on its next use while an
// untouched one is probed exactly once.

/// Cap on tracked files. A session that walks hundreds of files should not grow
/// this without bound; entries are tiny and order carries no information, so the
/// map is simply cleared when it overflows rather than evicted one at a time.
const MAX_CACHED_FILE_INFO: usize = 256;

/// Identity of the bytes on disk: (mtime, length).
pub(crate) type FileStamp = (Option<SystemTime>, u64);

type InfoCache = HashMap<String, (Option<SystemTime>, u64, FileInfo)>;

fn info_cache() -> &'static Mutex<InfoCache> {
    static CACHE: OnceLock<Mutex<InfoCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Identity of the bytes on disk: (mtime, length). `None` mtime on filesystems
/// that do not report one — length alone still catches most rewrites, and the
/// probe cost is what we are avoiding, not correctness of the file itself.
pub(crate) fn file_stamp(path: &str) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok(), meta.len()))
}

pub fn get_file_info(path: &str) -> Result<FileInfo> {
    let stamp = file_stamp(path);

    if let Some((mtime, len)) = stamp {
        let cache = super::lock(info_cache());
        if let Some((cached_mtime, cached_len, info)) = cache.get(path) {
            if *cached_mtime == mtime && *cached_len == len {
                return Ok(*info);
            }
        }
    }

    let info = if is_ffmpeg_ext(path) {
        super::ffmpeg_stream::get_file_info(path)?
    } else {
        get_file_info_symphonia(path)?
    };

    // A file we could not stat is still probed, just never cached.
    if let Some((mtime, len)) = stamp {
        let mut cache = super::lock(info_cache());
        if cache.len() >= MAX_CACHED_FILE_INFO && !cache.contains_key(path) {
            cache.clear();
        }
        cache.insert(path.to_string(), (mtime, len, info));
    }

    Ok(info)
}

/// A probed container with its audio track picked out — the open/probe steps
/// `get_file_info_symphonia` and `SymphoniaStream::open` both start from.
struct OpenedFile {
    format: Box<dyn FormatReader>,
    track_id: u32,
    /// Base (pre-SBR) rate and channel count from the codec parameters.
    sample_rate: u32,
    channels: u16,
    time_base: Option<TimeBase>,
    num_frames: Option<u64>,
    delay: u64,
    padding: u64,
}

fn open_symphonia(path: &str) -> Result<OpenedFile> {
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
    let (track_id, sample_rate, channels, time_base, num_frames, delay, padding) = {
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
            track.num_frames,
            track.delay.unwrap_or(0) as u64,
            track.padding.unwrap_or(0) as u64,
        )
    };

    Ok(OpenedFile { format, track_id, sample_rate, channels, time_base, num_frames, delay, padding })
}

fn get_file_info_symphonia(path: &str) -> Result<FileInfo> {
    let OpenedFile {
        mut format,
        track_id,
        sample_rate: initial_sr,
        channels: initial_channels,
        num_frames: n_frames,
        delay,
        padding,
        ..
    } = open_symphonia(path)?;

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
// corresponds to exactly `round(start_sec * sample_rate)` in the file.
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

/// Seek slack used by `open` and `seek_to`: the container seek aims this far
/// before the requested position so it reliably lands *before* it, and the
/// alignment phase in `read()` skips the remainder. Big enough to cover any
/// realistic seek imprecision plus encoder delay.
pub const DEFAULT_SEEK_MARGIN_SEC: f64 = 0.5;

/// Streaming PCM reader. Yields interleaved f32 samples at the file's native
/// sample rate and channel count, starting from an exact sample position.
pub struct SymphoniaStream {
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

/// Consecutive demuxer errors tolerated before giving up on a stream; bounds the
/// loop on a reader that keeps failing without making progress.
const MAX_CONSECUTIVE_DEMUX_ERRORS: u32 = 64;

/// Frames of silence to insert so a packet that decoded after a loss starts at
/// the position its own timestamp claims.
///
/// `expected` is where the stream's running count says it should begin, `pts_frame`
/// is where the container says it does. Only a forward gap is padded, and only a
/// plausible one (a corrupt timestamp must not allocate minutes of silence).
fn resync_gap_frames(pts_frame: u64, expected: u64, sample_rate: u32) -> u64 {
    let max_gap = sample_rate as u64 * 10;
    match pts_frame.checked_sub(expected) {
        Some(gap) if gap <= max_gap => gap,
        _ => 0,
    }
}

/// The frames a forward-only `skip_to` must discard to land on `start_sec`
/// from `next_output_frame`. Shared by both stream kinds (symphonia here,
/// `ffmpeg_stream`), which differ only in how they throw the frames away.
/// Errors on a non-finite or negative time, or one behind the current position.
pub(super) fn skip_gap_frames(start_sec: f64, sample_rate: u32, next_output_frame: u64) -> Result<u64> {
    if !start_sec.is_finite() || start_sec < 0.0 {
        return Err(anyhow::anyhow!(
            "start_sec must be a finite non-negative number, got {start_sec}"
        ));
    }
    let target_frame = (start_sec * sample_rate as f64).round() as u64;
    if target_frame < next_output_frame {
        return Err(anyhow::anyhow!(
            "skip_to cannot move backwards ({start_sec}s is behind the current position)"
        ));
    }
    Ok(target_frame - next_output_frame)
}

impl SymphoniaStream {
    /// Open a file and seek to just before `start_sec` using the 500ms margin
    /// + first-packet timestamp technique (see module-level doc).
    pub fn open(path: &str, start_sec: f64) -> Result<Self> {
        let OpenedFile {
            format,
            track_id,
            sample_rate: initial_sr,
            channels: initial_channels,
            time_base,
            delay,
            ..
        } = open_symphonia(path)?;

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
        let mut stream = SymphoniaStream {
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
        stream.reposition(start_sec, true, DEFAULT_SEEK_MARGIN_SEC)?;
        Ok(stream)
    }

    /// Advance to `start_sec` by reading and discarding, without seeking.
    ///
    /// `seek_to` aims `margin_sec` BEFORE its target, so asking it for a
    /// position only slightly ahead of where the stream already sits actually
    /// seeks backwards — and a backward seek restarts the container scan from
    /// byte 0 (~230ms at depth in a 49.7h MP3, measured at every distance from
    /// 50ms to 60s). Skipping forward instead costs one decode of the gap, which
    /// is bounded by the margin and takes microseconds.
    ///
    /// Errors if `start_sec` is behind the current position, which callers must
    /// treat as "not reachable from here". Landing is sample-exact: the next
    /// `read()` returns the frame at round(start_sec * sample_rate), the same
    /// guarantee `seek_to` gives.
    pub fn skip_to(&mut self, start_sec: f64) -> Result<()> {
        let gap = skip_gap_frames(start_sec, self.sample_rate, self.next_output_frame)?;

        // Bounded chunks: read() allocates its whole request up front, and the
        // gap here is whatever the caller asked for.
        const SKIP_CHUNK_FRAMES: usize = 16 * 1024;
        let mut remaining = gap as usize;
        while remaining > 0 {
            let (_, frames_read) = self.read(remaining.min(SKIP_CHUNK_FRAMES))?;
            if frames_read == 0 {
                return Err(anyhow::anyhow!("EOF before reaching {start_sec}s"));
            }
            remaining -= frames_read;
        }
        Ok(())
    }

    /// Reposition an already-open stream to `start_sec`, restoring the same
    /// sample-accuracy contract `open` establishes: the next `read()` returns
    /// the frame at exactly `round(start_sec * sample_rate)`.
    ///
    /// This is the whole reason the seek/align phase is factored out of `open`.
    /// Sampling a file at scattered positions — which is what building a coarse
    /// overview column-by-column does — otherwise had to re-`open` per position,
    /// paying a full symphonia probe (and, for the alternative of reading
    /// forward, decoding every intervening sample just to throw it away).
    /// Reusing the format reader and decoder makes repositioning cost a seek.
    /// `margin_sec` is decoded and discarded on the way to `start_sec`, so it is
    /// pure overhead — it exists only to absorb a container seek that lands
    /// later than asked. DEFAULT_SEEK_MARGIN_SEC is the safe default; callers
    /// that sample many positions and read a short span at each (the coarse
    /// spectrogram walk reads 0.3s per column) otherwise spend more time on the
    /// margin than on the audio they keep, and can trade slack for throughput.
    ///
    /// A smaller margin does NOT relax the sample-accuracy contract: alignment
    /// is unchanged, and a seek that overshoots anyway is still handled (read()
    /// pads the gap with silence) rather than returning misaligned audio.
    pub fn seek_to(&mut self, start_sec: f64, margin_sec: f64) -> Result<()> {
        self.reposition(start_sec, false, margin_sec.max(0.0))
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
    fn reposition(
        &mut self,
        start_sec: f64,
        reader_is_fresh: bool,
        seek_margin_sec: f64,
    ) -> Result<()> {
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
        // default seek margin (typical MP3 LAME delay ≈ 26ms at 44.1 kHz), so
        // seeking to (start_sec - 0.5) container-seconds reliably lands before
        // the desired audible position. The alignment phase in read() skips the
        // remaining frames, including any encoder padding when start_sec is 0.
        let seek_target = (start_sec - seek_margin_sec).max(0.0);

        if seek_target > 0.0 || !reader_is_fresh {
            let sought = self.format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::try_from_secs_f64(seek_target).unwrap_or(Time::ZERO),
                    track_id: Some(self.track_id),
                },
            );
            match sought {
                Ok(_) => {}
                // A fresh reader still sits at the start of the stream, so a
                // container that cannot seek (or cannot seek *this* way) falls
                // back to decoding forward to the target — slow, but aligned.
                // Out-of-range is a real answer (the target is past the end)
                // and would only turn into a scan of the whole file.
                Err(SymphoniaError::SeekError(kind))
                    if reader_is_fresh && !matches!(kind, SeekErrorKind::OutOfRange) => {}
                // A reused reader is wherever the last read left it; realigning
                // against that would return audio from the wrong time.
                Err(e) => {
                    self.eof = true;
                    return Err(anyhow::anyhow!("Seek to {seek_target}s failed: {e}"));
                }
            }
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
            decoded.copy_to_vec_interleaved::<f32>(&mut self.pending);
            first_abs_frame = self
                .pts_to_frame(packet.pts)
                .unwrap_or_else(|| (seek_target * self.sample_rate as f64).round() as u64);
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

    /// Playback position in seconds — where a `read()` would resume. The stream
    /// pool uses it to pick a stream that can reach a target by seeking FORWARD.
    pub fn position_secs(&self) -> f64 {
        self.next_output_frame as f64 / self.sample_rate.max(1) as f64
    }

    /// A packet timestamp as a frame index at the real (post-SBR) sample rate.
    fn pts_to_frame(&self, pts: Timestamp) -> Option<u64> {
        self.time_base
            .and_then(|tb| tb.calc_time(pts))
            .map(|t| (t.as_secs_f64() * self.sample_rate as f64).round() as u64)
    }

    /// Decode and buffer the next packet. Updates `abs_frame` to the packet's
    /// starting position. Returns `false` at end of stream; read errors other
    /// than a truncated file are returned as `Err`.
    ///
    /// A packet that fails to decode, or a demuxer hiccup, loses its frames.
    /// `abs_frame` only advances by what was actually decoded, so skipping
    /// silently would shift every later sample earlier in time. Instead, the
    /// next good packet's timestamp says where it really starts, and the gap is
    /// filled with silence (see `resync_gap_frames`).
    fn fill_next_packet(&mut self) -> Result<bool> {
        // Advance abs_frame past the *full* previous packet before clearing it.
        // Using pending.len() / channels (the full packet size) is correct here
        // because abs_frame tracks the start of the *next* packet, not the
        // consumed-up-to position. pending_pos (the read cursor) is not used
        // because that would drift abs_frame by the alignment-skipped head on
        // the first packet.
        let ch = self.channels.max(1) as usize;
        let prev_frames = self.pending.len() / ch;
        self.abs_frame += prev_frames as u64;
        self.pending.clear();
        self.pending_pos = 0;

        // Set once a packet has been lost since the last good one.
        let mut lost_data = false;
        let mut demux_errors = 0u32;
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(false),
                // A file cut short mid-packet: the normal way a truncated file ends.
                Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                // Malformed container data: the reader resyncs on the next call.
                Err(SymphoniaError::DecodeError(msg)) => {
                    demux_errors += 1;
                    if demux_errors > MAX_CONSECUTIVE_DEMUX_ERRORS {
                        return Err(anyhow::anyhow!("Too many corrupt packets in a row: {msg}"));
                    }
                    lost_data = true;
                    continue;
                }
                Err(e) => {
                    eprintln!("SymphoniaStream: read error at frame {}: {e}", self.abs_frame);
                    return Err(anyhow::anyhow!("Audio read failed: {e}"));
                }
            };
            demux_errors = 0;

            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(e) => {
                    if matches!(e, SymphoniaError::ResetRequired) {
                        self.decoder.reset();
                    }
                    lost_data = true;
                    continue;
                }
            };

            // `copy_to_vec_interleaved` resizes `pending` to fit exactly and
            // copies in one call; since `pending` is cleared (not dropped)
            // above, its capacity is reused across packets so steady-state
            // decoding stays allocation-free here, same as before.
            decoded.copy_to_vec_interleaved::<f32>(&mut self.pending);
            if self.pending.is_empty() {
                continue; // a packet that yields no frames is not the end of the stream
            }

            if lost_data {
                if let Some(pts_frame) = self.pts_to_frame(packet.pts) {
                    let gap = resync_gap_frames(pts_frame, self.abs_frame, self.sample_rate);
                    if gap > 0 {
                        eprintln!(
                            "SymphoniaStream: {gap} frames lost to a corrupt packet at frame {}; padding with silence",
                            self.abs_frame
                        );
                        self.pending.splice(0..0, std::iter::repeat_n(0.0f32, gap as usize * ch));
                    }
                }
            }
            return Ok(true);
        }
    }

    /// Read up to `max_frames` interleaved f32 frames. Returns `(samples, frames_read)`.
    /// `frames_read == 0` means EOF. `samples.len() == frames_read * channels`.
    pub fn read(&mut self, max_frames: usize) -> Result<(Vec<f32>, usize)> {
        let ch = self.channels.max(1) as usize;
        let mut output: Vec<f32> = Vec::with_capacity(max_frames * ch);

        while output.len() / ch < max_frames {
            // Refill from the next decoded packet when current one is exhausted.
            if self.pending_pos >= self.pending.len() {
                if self.eof {
                    break;
                }
                if !self.fill_next_packet()? { self.eof = true; break; }
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

// ── PcmStream: backend dispatch ────────────────────────────────────────────────
//
// symphonia has no WMA decoder (nor does anything else in the Rust ecosystem —
// it's a proprietary codec), so `.wma` is routed to `ffmpeg_stream`, which
// shells out to a system-installed `ffmpeg`/`ffprobe` rather than linking
// libavcodec (see that module's doc comment for the licensing/bundling
// rationale). Every other extension keeps using `SymphoniaStream` unchanged.
//
// Callers (`stream_pool.rs`, `commands/audio.rs`) only ever call `PcmStream`'s
// public methods, never touch its fields, so this dispatch is invisible to them.
pub enum PcmStream {
    Symphonia(SymphoniaStream),
    Ffmpeg(super::ffmpeg_stream::FfmpegStream),
}

impl PcmStream {
    pub fn open(path: &str, start_sec: f64) -> Result<Self> {
        if is_ffmpeg_ext(path) {
            Ok(PcmStream::Ffmpeg(super::ffmpeg_stream::FfmpegStream::open(
                path, start_sec,
            )?))
        } else {
            Ok(PcmStream::Symphonia(SymphoniaStream::open(path, start_sec)?))
        }
    }

    pub fn skip_to(&mut self, start_sec: f64) -> Result<()> {
        match self {
            PcmStream::Symphonia(s) => s.skip_to(start_sec),
            PcmStream::Ffmpeg(s) => s.skip_to(start_sec),
        }
    }

    pub fn seek_to(&mut self, start_sec: f64, margin_sec: f64) -> Result<()> {
        match self {
            PcmStream::Symphonia(s) => s.seek_to(start_sec, margin_sec),
            PcmStream::Ffmpeg(s) => s.seek_to(start_sec, margin_sec),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        match self {
            PcmStream::Symphonia(s) => s.sample_rate(),
            PcmStream::Ffmpeg(s) => s.sample_rate(),
        }
    }

    pub fn channels(&self) -> u16 {
        match self {
            PcmStream::Symphonia(s) => s.channels(),
            PcmStream::Ffmpeg(s) => s.channels(),
        }
    }

    pub fn position_frames(&self) -> u64 {
        match self {
            PcmStream::Symphonia(s) => s.position_frames(),
            PcmStream::Ffmpeg(s) => s.position_frames(),
        }
    }

    pub fn position_secs(&self) -> f64 {
        match self {
            PcmStream::Symphonia(s) => s.position_secs(),
            PcmStream::Ffmpeg(s) => s.position_secs(),
        }
    }

    pub fn read(&mut self, max_frames: usize) -> Result<(Vec<f32>, usize)> {
        match self {
            PcmStream::Symphonia(s) => s.read(max_frames),
            PcmStream::Ffmpeg(s) => s.read(max_frames),
        }
    }

    /// Whether holding this stream idle also holds an OS process.
    ///
    /// A `Symphonia` stream idles as a file handle and some buffered container
    /// state. An `Ffmpeg` one idles as a live `ffmpeg` child, blocked writing to
    /// a full pipe and killed only on drop — cheap in CPU, but tens of MB of RSS
    /// apiece. `stream_pool` uses this to expire subprocess-backed streams much
    /// sooner than it expires the rest, so a long pool TTL does not leave a
    /// handful of idle decoders resident (see POOL_TTL there).
    pub fn is_subprocess_backed(&self) -> bool {
        matches!(self, PcmStream::Ffmpeg(_))
    }
}

// ── decode_audio_range ────────────────────────────────────────────────────────

/// Decodes PCM samples for [start_sec, start_sec + duration_sec).
/// Returns mono f32 samples (averaged across all channels) and the sample rate.
///
/// ── Sample-accuracy contract ─────────────────────────────────────────────────
/// The returned buffer is aligned to `start_sec` at sample resolution:
///   output[0] corresponds to frame round(start_sec * sample_rate)
///   output[i] corresponds to frame round(start_sec * sample_rate) + i
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
#[cfg(test)]
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
    Ok(read_mono_range(&mut stream, duration_sec))
}

/// Read `duration_sec` of mono (channel-averaged) samples from wherever
/// `stream` is currently positioned. Returns the samples and the stream's
/// sample rate; a short result means EOF, matching decode_audio_range.
///
/// Split out of `decode_audio_range` so callers holding a stream already
/// positioned at the range start — a pooled stream that forward-seeked instead
/// of re-opening the file — read through the same code path.
pub fn read_mono_range(stream: &mut PcmStream, duration_sec: f64) -> (Vec<f32>, u32) {
    let sample_rate = stream.sample_rate();
    let ch = stream.channels().max(1) as usize;
    let target_frames = (duration_sec * sample_rate as f64).ceil() as usize;
    let mut output: Vec<f32> = Vec::with_capacity(target_frames);

    while output.len() < target_frames {
        let want = target_frames - output.len();
        let (interleaved, frames_read) = match stream.read(want) {
            Ok(r) => r,
            Err(_) => break,
        };
        if frames_read == 0 {
            break;
        }
        output.extend(mix_to_mono(&interleaved, ch));
    }

    (output, sample_rate)
}

/// Mono mixdown of interleaved samples: each frame becomes the average of its
/// `ch` channels. The single definition of "mono" for playback-adjacent code
/// (spectrograms, peak, `decode_audio_range`), so they all agree. `ch` is
/// clamped to at least 1.
pub fn mix_to_mono(interleaved: &[f32], ch: usize) -> impl Iterator<Item = f32> + '_ {
    let ch = ch.max(1);
    interleaved
        .chunks_exact(ch)
        .map(move |frame| frame.iter().fold(0.0f32, |sum, &s| sum + s) / ch as f32)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "decoder_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "decoder_bench.rs"]
mod seek_bench;
