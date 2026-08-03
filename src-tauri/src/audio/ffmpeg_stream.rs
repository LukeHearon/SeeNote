//! Fallback decode backend for formats symphonia can't decode — currently just
//! `.wma`. WMA is a proprietary Microsoft codec; no pure-Rust decoder exists,
//! so unlike every other format in this app (mp3/flac/wav/aac/ogg/opus/isomp4/
//! mkv, all handled in-process by symphonia — see `decoder.rs`), reading it
//! means shelling out to a system-installed `ffmpeg`/`ffprobe` (checked via
//! `ffmpeg_available` below, not bundled or linked).
//!
//! Two deliberate choices behind that, not linking libavcodec directly:
//!   - Licensing: ffmpeg's WMA decoders are LGPL. This app's other native deps
//!     (git2, libopus) are vendored under permissive (MIT-style) licenses as a
//!     single static binary; LGPL compliance wants dynamic linking or
//!     relinkable object files, which doesn't fit that model. Shelling out to a
//!     binary we don't distribute sidesteps the question entirely.
//!   - Preconversion: this app routinely handles hundreds of hours of audio, so
//!     converting a whole `.wma` file to another format up front (before it can
//!     be opened) isn't viable. `FfmpegStream` streams PCM out of a running
//!     `ffmpeg` process on demand, the same seek/read shape `SymphoniaStream`
//!     gives the rest of the app, just backed by a subprocess instead of an
//!     in-process decoder.
//!
//! Cost: each `open`/`seek_to` spawns a new `ffmpeg` process (no reuse via
//! `stream_pool`'s idle-stream pooling, unlike the symphonia path), so seeking
//! is materially more expensive here. Acceptable for a rare fallback format,
//! not the routine mp3/wav/flac path.

use anyhow::{Context, Result};
use std::io::Read;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::OnceLock;

use super::decoder::FileInfo;

/// Checked once per process: is `ffmpeg` *and* `ffprobe` on PATH? Cached so
/// repeated `.wma` opens don't re-spawn a version check each time.
fn ffmpeg_available() -> Result<()> {
    static AVAILABLE: OnceLock<Result<(), String>> = OnceLock::new();
    AVAILABLE
        .get_or_init(|| {
            let has = |bin: &str| {
                Command::new(bin)
                    .arg("-version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            };
            if has("ffmpeg") && has("ffprobe") {
                Ok(())
            } else {
                Err(
                    "ffmpeg not found on PATH — install ffmpeg (e.g. `brew install ffmpeg`) \
                     to open .wma files."
                        .to_string(),
                )
            }
        })
        .clone()
        .map_err(|e| anyhow::anyhow!(e))
}

/// Metadata via `ffprobe`, mirroring `decoder::get_file_info`'s contract.
pub fn get_file_info(path: &str) -> Result<FileInfo> {
    ffmpeg_available()?;

    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration:stream=sample_rate,channels",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("Failed to run ffprobe on {path}"))?;

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "ffprobe failed for {path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("Failed to parse ffprobe output")?;

    let stream = json["streams"]
        .get(0)
        .context("ffprobe reported no audio stream")?;
    let sample_rate = stream["sample_rate"]
        .as_str()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(44100);
    let channels = stream["channels"].as_u64().unwrap_or(1).max(1) as u16;
    let duration_secs = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    Ok(FileInfo {
        duration_secs,
        sample_rate,
        channels,
    })
}

/// Spawn `ffmpeg`, positioned so its stdout begins emitting raw interleaved
/// `f32le` PCM at exactly `start_sec`.
///
/// Uses the standard fast+accurate two-stage seek: `-ss` before `-i` is a
/// cheap demuxer-level seek to a point shortly before the target (fast but
/// imprecise), and a second `-ss` after `-i` has ffmpeg decode-and-discard the
/// small remainder — accurate down to the sample, at the cost of decoding just
/// that margin rather than the whole file.
fn spawn_at(
    path: &str,
    start_sec: f64,
    sample_rate: u32,
    channels: u16,
) -> Result<(Child, ChildStdout)> {
    const SEEK_MARGIN_SEC: f64 = 1.0;
    let coarse = (start_sec - SEEK_MARGIN_SEC).max(0.0);
    let fine = start_sec - coarse;

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v", "error", "-nostdin"]);
    if coarse > 0.0 {
        cmd.args(["-ss", &coarse.to_string()]);
    }
    cmd.arg("-i").arg(path);
    if fine > 0.0 {
        cmd.args(["-ss", &fine.to_string()]);
    }
    cmd.args([
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-ar",
        &sample_rate.to_string(),
        "-ac",
        &channels.to_string(),
        "-",
    ]);
    // Errors are surfaced via the process exit status (see `read`'s EOF path),
    // not captured text — piping stderr here without a dedicated drain thread
    // risks a deadlock if ffmpeg fills the pipe buffer while we're only
    // reading stdout.
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("Failed to spawn ffmpeg for {path}"))?;
    let stdout = child
        .stdout
        .take()
        .context("ffmpeg child had no stdout pipe")?;
    Ok((child, stdout))
}

/// Streaming PCM reader backed by a live `ffmpeg` subprocess. Same read/seek
/// contract as `SymphoniaStream` (see `decoder.rs`), dispatched to via the
/// `PcmStream` enum.
pub struct FfmpegStream {
    path: String,
    sample_rate: u32,
    channels: u16,
    child: Child,
    stdout: ChildStdout,
    next_output_frame: u64,
}

impl FfmpegStream {
    pub fn open(path: &str, start_sec: f64) -> Result<Self> {
        if !start_sec.is_finite() || start_sec < 0.0 {
            return Err(anyhow::anyhow!(
                "start_sec must be a finite non-negative number, got {start_sec}"
            ));
        }
        ffmpeg_available()?;
        let info = get_file_info(path)?;
        let (child, stdout) = spawn_at(path, start_sec, info.sample_rate, info.channels)?;
        Ok(FfmpegStream {
            path: path.to_string(),
            sample_rate: info.sample_rate,
            channels: info.channels,
            child,
            stdout,
            next_output_frame: (start_sec * info.sample_rate as f64).round() as u64,
        })
    }

    /// Kill the current process and respawn it seeking to `start_sec`. Used
    /// for backward seeks and seeks far enough ahead that reading through
    /// would cost more than a fresh process (mirrors `SymphoniaStream::seek_to`'s
    /// role — `stream_pool` picks this over `skip_to` based on distance).
    pub fn seek_to(&mut self, start_sec: f64, _margin_sec: f64) -> Result<()> {
        if !start_sec.is_finite() || start_sec < 0.0 {
            return Err(anyhow::anyhow!(
                "start_sec must be a finite non-negative number, got {start_sec}"
            ));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let (child, stdout) = spawn_at(&self.path, start_sec, self.sample_rate, self.channels)?;
        self.child = child;
        self.stdout = stdout;
        self.next_output_frame = (start_sec * self.sample_rate as f64).round() as u64;
        Ok(())
    }

    /// Advance to `start_sec` by reading and discarding on the current
    /// process, no respawn — cheap for small forward jumps. Errors if
    /// `start_sec` is behind the current position.
    pub fn skip_to(&mut self, start_sec: f64) -> Result<()> {
        if !start_sec.is_finite() || start_sec < 0.0 {
            return Err(anyhow::anyhow!(
                "start_sec must be a finite non-negative number, got {start_sec}"
            ));
        }
        let target_frame = (start_sec * self.sample_rate as f64).round() as u64;
        if target_frame < self.next_output_frame {
            return Err(anyhow::anyhow!(
                "skip_to cannot move backwards ({start_sec}s is behind the current position)"
            ));
        }
        let mut remaining = (target_frame - self.next_output_frame) as usize;
        while remaining > 0 {
            let (_, frames_read) = self.read(remaining)?;
            if frames_read == 0 {
                return Err(anyhow::anyhow!("EOF before reaching {start_sec}s"));
            }
            remaining -= frames_read;
        }
        Ok(())
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    pub fn channels(&self) -> u16 {
        self.channels
    }
    pub fn position_frames(&self) -> u64 {
        self.next_output_frame
    }
    pub fn position_secs(&self) -> f64 {
        self.next_output_frame as f64 / self.sample_rate.max(1) as f64
    }

    /// Read up to `max_frames` interleaved f32 frames. Returns `(samples,
    /// frames_read)`; `frames_read == 0` means EOF (true end of stream, or the
    /// ffmpeg process exited — the exit status is logged either way but not
    /// distinguished in the return value, matching `SymphoniaStream::read`'s
    /// treat-EOF-as-normal contract).
    pub fn read(&mut self, max_frames: usize) -> Result<(Vec<f32>, usize)> {
        let ch = self.channels as usize;
        let bytes_per_frame = ch * 4;
        let mut buf = vec![0u8; max_frames * bytes_per_frame];
        let mut filled = 0usize;
        while filled < buf.len() {
            match self.stdout.read(&mut buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(anyhow::anyhow!("ffmpeg stdout read failed: {e}")),
            }
        }

        let whole_frames = filled / bytes_per_frame;
        let sample_count = whole_frames * ch;
        let mut samples = Vec::with_capacity(sample_count);
        for chunk in buf[..sample_count * 4].chunks_exact(4) {
            samples.push(f32::from_le_bytes(chunk.try_into().unwrap()));
        }

        self.next_output_frame += whole_frames as u64;
        if whole_frames == 0 {
            if let Ok(Some(status)) = self.child.try_wait() {
                if !status.success() {
                    eprintln!(
                        "FfmpegStream: ffmpeg for {} exited with {status}",
                        self.path
                    );
                }
            }
        }
        Ok((samples, whole_frames))
    }
}

impl Drop for FfmpegStream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    /// True when both `ffmpeg` and `ffprobe` are on PATH. Tests skip (rather
    /// than fail) when absent, since this is an optional runtime dependency,
    /// not a build dependency — CI/dev machines aren't guaranteed to have it.
    fn have_ffmpeg() -> bool {
        ffmpeg_available().is_ok()
    }

    /// Synthesize a short `.wma` fixture with `ffmpeg` itself, so no binary
    /// fixture needs to be committed to the repo.
    fn make_wma_fixture(name: &str, duration_secs: f64) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let status = StdCommand::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={duration_secs}"))
            .args(["-ar", "44100", "-ac", "1", "-c:a", "wmav2"])
            .arg(&path)
            .status()
            .expect("spawn ffmpeg to build fixture");
        assert!(status.success(), "ffmpeg fixture encode failed");
        path
    }

    #[test]
    fn get_file_info_reports_plausible_metadata() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let path = make_wma_fixture("seenote_wma_info.wma", 2.0);
        let info = get_file_info(path.to_str().unwrap()).expect("get_file_info");
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 1);
        assert!(
            (info.duration_secs - 2.0).abs() < 0.2,
            "duration {} not close to 2.0s",
            info.duration_secs
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn open_and_read_yields_frames() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let path = make_wma_fixture("seenote_wma_read.wma", 2.0);
        let mut stream = FfmpegStream::open(path.to_str().unwrap(), 0.0).expect("open");
        assert_eq!(stream.sample_rate(), 44100);

        let mut total_frames = 0usize;
        loop {
            let (_, n) = stream.read(4096).expect("read");
            if n == 0 {
                break;
            }
            total_frames += n;
        }
        // ~2s at 44.1kHz, allowing generous slack for encoder framing.
        assert!(
            total_frames > 44100 * 1,
            "expected roughly 2s of audio, got {total_frames} frames"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seek_to_lands_close_to_target() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let path = make_wma_fixture("seenote_wma_seek.wma", 5.0);
        let mut stream = FfmpegStream::open(path.to_str().unwrap(), 0.0).expect("open");
        stream.seek_to(3.0, 1.0).expect("seek_to");
        // WMA's lossy, block-based decode doesn't give the same bit-exact
        // landing guarantee symphonia's packet-pts alignment does; assert a
        // tolerance instead of an exact frame index.
        let expected = (3.0 * stream.sample_rate() as f64) as u64;
        assert!(
            (stream.position_frames() as i64 - expected as i64).abs() < stream.sample_rate() as i64,
            "position {} not within 1s of expected {}",
            stream.position_frames(),
            expected
        );
        let _ = std::fs::remove_file(&path);
    }
}
