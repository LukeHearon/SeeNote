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
//! Cost: `open` spawns a new `ffmpeg` process, and so does any `seek_to` that
//! cannot be served by reading forward on the running one (see `seek_to`).
//! Spawning is the dominant expense on this backend — the container seek itself
//! is nearly free, since ASF carries an index — so the seek strategy is built
//! around avoiding spawns, not around avoiding seeks the way the symphonia path
//! is.

use anyhow::{Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::decoder::FileInfo;

/// Custom ffmpeg/ffprobe location from Application Settings (see
/// `commands::audio::set_ffmpeg_path`), used in place of a PATH lookup when
/// set. `None` means "search for one" (see `candidate_dirs`), matching an
/// empty/unset app setting.
static FFMPEG_PATH_OVERRIDE: Mutex<Option<String>> = Mutex::new(None);

/// Cached result of the last resolution attempt (see `resolve_dir`), so
/// repeated `.wma` opens don't re-walk the candidate directories and re-spawn
/// version checks each time. `Ok` holds the directory both binaries live in.
/// Reset by `set_ffmpeg_path_override` so a change takes effect without a
/// restart.
static RESOLVED_CACHE: Mutex<Option<Result<PathBuf, String>>> = Mutex::new(None);

/// Set (or clear, with `None`/empty) the configured ffmpeg/ffprobe location.
/// Called once at startup with whatever Application Settings holds, and again
/// whenever the user edits the setting.
pub fn set_ffmpeg_path_override(path: Option<String>) {
    *FFMPEG_PATH_OVERRIDE.lock().unwrap() = path.filter(|p| !p.trim().is_empty());
    *RESOLVED_CACHE.lock().unwrap() = None;
}

/// Executable file name for one of the two binaries we need, with the
/// platform's suffix (`.exe` on Windows, bare elsewhere).
fn bin_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Does `dir` hold both `ffmpeg` and `ffprobe` as files? Cheap existence check
/// used to shortlist candidates before paying for a `-version` spawn.
fn dir_has_both(dir: &Path) -> bool {
    dir.join(bin_name("ffmpeg")).is_file() && dir.join(bin_name("ffprobe")).is_file()
}

/// Do both binaries in `dir` actually run? The existence check above can be
/// fooled by a broken symlink, a wrong-architecture build, or a quarantined
/// download, so the directory we commit to is confirmed by running each.
fn dir_works(dir: &Path) -> bool {
    ["ffmpeg", "ffprobe"].iter().all(|name| {
        Command::new(dir.join(bin_name(name)))
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// Directories to search, in order: everything on `PATH` first (so a user's own
/// install/shell setup always wins), then the places the platform's usual
/// installers put ffmpeg. Package managers are listed ahead of hand-unpacked
/// locations since they're likelier to be kept up to date.
///
/// Searching these matters because a GUI app launched from Finder/Explorer does
/// *not* inherit the login shell's `PATH` — on macOS an app bundle typically
/// sees only `/usr/bin:/bin:/usr/sbin:/sbin`, so a perfectly good Homebrew
/// ffmpeg is invisible to a bare `Command::new("ffmpeg")`.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    // `None` when there's no home directory to anchor to, in which case the
    // `extend` below adds nothing.
    let in_home = |rel: &str| home.as_ref().map(|h| h.join(rel));

    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin")); // Homebrew, Apple silicon
        dirs.push(PathBuf::from("/usr/local/bin")); // Homebrew, Intel
        dirs.push(PathBuf::from("/opt/homebrew/opt/ffmpeg/bin"));
        dirs.push(PathBuf::from("/usr/local/opt/ffmpeg/bin"));
        dirs.push(PathBuf::from("/opt/local/bin")); // MacPorts
        dirs.push(PathBuf::from("/sw/bin")); // Fink
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.extend(in_home(".local/bin"));
        dirs.extend(in_home("bin"));
        dirs.extend(in_home("Applications/ffmpeg"));
        dirs.push(PathBuf::from("/Applications/ffmpeg"));
    } else if cfg!(target_os = "windows") {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(pf) = std::env::var_os(var) {
                let pf = PathBuf::from(pf);
                dirs.push(pf.join("ffmpeg").join("bin"));
                dirs.push(pf.join("ffmpeg"));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            dirs.push(local.join("Microsoft").join("WinGet").join("Links")); // winget shims
            dirs.push(local.join("Programs").join("ffmpeg").join("bin"));
        }
        dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
        dirs.extend(in_home(r"scoop\shims"));
    } else {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/ffmpeg/bin"));
        dirs.push(PathBuf::from("/snap/bin"));
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/bin"));
        dirs.extend(in_home(".local/bin"));
        dirs.extend(in_home("bin"));
    }

    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    dirs
}

/// The directory holding a working `ffmpeg`+`ffprobe` pair, or an error message
/// explaining what to do about it. Uses the configured location when set (the
/// user's choice is never second-guessed by a search), otherwise the first
/// candidate directory that has both binaries and can run them.
///
/// Cached in `RESOLVED_CACHE`; the search only ever runs once per setting.
fn resolve_dir() -> Result<PathBuf, String> {
    if let Some(cached) = RESOLVED_CACHE.lock().unwrap().clone() {
        return cached;
    }

    let configured = FFMPEG_PATH_OVERRIDE.lock().unwrap().clone();
    let result = match configured {
        Some(configured) => {
            // The setting may name either binary or the directory holding them.
            let p = PathBuf::from(configured.trim());
            let dir = if p.is_dir() {
                p
            } else {
                p.parent()
                    .filter(|d| !d.as_os_str().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or(p)
            };
            if dir_works(&dir) {
                Ok(dir)
            } else {
                Err("ffmpeg/ffprobe not found at the configured location — check it in \
                     Application Settings, or clear it to search your system automatically."
                    .to_string())
            }
        }
        None => candidate_dirs()
            .into_iter()
            .find(|d| dir_has_both(d) && dir_works(d))
            .ok_or_else(|| {
                "ffmpeg not found — install ffmpeg (e.g. `brew install ffmpeg`) or set a \
                 custom location in Application Settings to open .wma files."
                    .to_string()
            }),
    };

    *RESOLVED_CACHE.lock().unwrap() = Some(result.clone());
    result
}

/// Full path of the `ffmpeg` binary found by the search, if any. Backs the
/// Application Settings field, which shows the auto-detected path so the user
/// can see whether detection succeeded (see `commands::audio::detect_ffmpeg`).
pub fn detected_ffmpeg_path() -> Option<String> {
    resolve_dir()
        .ok()
        .map(|d| d.join(bin_name("ffmpeg")).to_string_lossy().into_owned())
}

/// Resolve the `ffmpeg` or `ffprobe` binary to invoke. Falls back to the bare
/// name (PATH lookup by `Command`) only when resolution failed outright, so the
/// resulting spawn error mentions the plain binary name.
fn resolve_bin(name: &str) -> PathBuf {
    match resolve_dir() {
        Ok(dir) => dir.join(bin_name(name)),
        Err(_) => PathBuf::from(name),
    }
}

/// Checked once (then cached — see `RESOLVED_CACHE`): are `ffmpeg` *and*
/// `ffprobe` available, at the configured location or anywhere we search?
fn ffmpeg_available() -> Result<()> {
    resolve_dir().map(|_| ()).map_err(|e| anyhow::anyhow!(e))
}

// ── Seek strategy: read forward vs. respawn ───────────────────────────────────
//
// A forward seek can be served two ways: read and discard the gap on the
// running process, or kill it and spawn a new one positioned at the target.
// Which is cheaper depends only on the size of the gap:
//
//   read-forward cost ≈ gap_secs / decode_throughput   (throughput as a
//                                                       realtime multiple)
//   respawn cost      ≈ RESPAWN_COST_SEC               (flat — the container
//                                                       seek is O(1) on ASF)
//
// The crossover is `RESPAWN_COST_SEC * throughput` seconds of audio. It cannot
// be hardcoded: throughput swings by an order of magnitude across machines,
// codecs, and drives, and the coarse spectrogram walk's hop lands on either
// side of the crossover depending on file length (a 6.7h file's whole-file
// overview hops ~24s per column, a 50h file's hops ~176s). So throughput is
// measured from the reads this backend is already doing.
//
// Precision does not matter much: near the crossover the two costs are equal by
// definition, so guessing wrong there is nearly free, and far from it the
// decision is unambiguous.

/// Assumed cost of killing and respawning ffmpeg, seeking included. Measured at
/// 90–150ms across seek depths on a 98MB/6.7h `.wma` (the depth-independence is
/// the ASF index at work). Held as a constant rather than measured because the
/// spawn's true cost is split between `spawn_at` and ffmpeg's lazy startup
/// during the first `read`, which is not cleanly attributable.
const RESPAWN_COST_SEC: f64 = 0.1;

/// Decode throughput used before any read has been timed, as a multiple of
/// realtime. Deliberately well below the ~1200x measured on an Apple-silicon
/// laptop, so an unmeasured backend errs toward respawning. Only ever governs
/// the first seek of the process; every read after that feeds the estimate.
const SEED_THROUGHPUT_X: f64 = 300.0;

/// Weight of a new observation in the throughput EWMA. Low enough to ride out
/// a single slow read (a disk stall, a scheduler hiccup) without swinging the
/// estimate.
const THROUGHPUT_EWMA_ALPHA: f64 = 0.25;

/// Reads shorter than this are dominated by pipe-read syscall overhead rather
/// than decode work, so they are not sampled. Notably this excludes the coarse
/// spectrogram walk's per-column reads (one `fft_size` window), which means a
/// walk that only ever respawns never gathers a sample and stays on the seed.
/// That is self-correcting in the direction that matters: the estimate governs
/// only the decision to read forward, and every read-forward refreshes it.
const MIN_THROUGHPUT_SAMPLE_FRAMES: usize = 4096;

/// Observed decode throughput as a realtime multiple, shared across all streams
/// in the process (it is a property of the machine and codec, not of one file)
/// and stored as a rounded integer — 1x resolution is far finer than this
/// decision needs. Zero means "not yet measured".
static THROUGHPUT_X: AtomicU64 = AtomicU64::new(0);

fn throughput_x() -> f64 {
    match THROUGHPUT_X.load(Ordering::Relaxed) {
        0 => SEED_THROUGHPUT_X,
        v => v as f64,
    }
}

/// Fold one timed read into the throughput estimate. Racy under concurrent
/// streams (read-modify-write without a lock); harmless, since the value is a
/// heuristic and every writer is converging on the same number.
fn record_throughput(frames: usize, sample_rate: u32, elapsed: Duration) {
    if frames < MIN_THROUGHPUT_SAMPLE_FRAMES || sample_rate == 0 {
        return;
    }
    let secs = elapsed.as_secs_f64();
    if secs <= 0.0 {
        return;
    }
    let observed = (frames as f64 / sample_rate as f64) / secs;
    if !observed.is_finite() || observed <= 0.0 {
        return;
    }
    let prev = THROUGHPUT_X.load(Ordering::Relaxed);
    let next = if prev == 0 {
        observed
    } else {
        prev as f64 * (1.0 - THROUGHPUT_EWMA_ALPHA) + observed * THROUGHPUT_EWMA_ALPHA
    };
    THROUGHPUT_X.store(next.round().max(1.0) as u64, Ordering::Relaxed);
}

/// Whether reading `gap_secs` of audio away on the running process is projected
/// to beat killing it and spawning a new one, given a decode throughput of
/// `throughput` as a realtime multiple.
///
/// Split out as a pure function because it is the whole of the new seek policy,
/// and the alternative — asserting on where each path lands — is not available
/// here: WMA is lossy, so two decodes starting from different blocks do not
/// yield comparable waveforms (a pure tone is periodic and so ambiguous under
/// correlation; noise is not preserved through the codec at all).
fn prefers_read_forward(gap_secs: f64, throughput: f64) -> bool {
    gap_secs.is_finite() && gap_secs >= 0.0 && throughput > 0.0
        && gap_secs / throughput < RESPAWN_COST_SEC
}

/// Bytes pulled per iteration when discarding a gap. Bounds the working set no
/// matter how long the skip is — the previous read-based skip allocated the
/// entire gap up front (31MB for a 176s gap at 44.1kHz mono).
const DISCARD_CHUNK_BYTES: usize = 64 * 1024;

/// Metadata via `ffprobe`, mirroring `decoder::get_file_info`'s contract.
pub fn get_file_info(path: &str) -> Result<FileInfo> {
    ffmpeg_available()?;

    let output = Command::new(resolve_bin("ffprobe"))
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
/// small remainder, at the cost of decoding just that margin rather than the
/// whole file.
///
/// "Accurate" here means within a couple of samples, not exact — measured at
/// ~3 samples of offset against a stream read continuously to the same point
/// (see `forward_seek_matches_a_fresh_open_at_the_same_position`). Immaterial
/// at the scales this backend is used at, but it is why `seek_to` prefers
/// reading forward where it can: that path counts every frame it discards and
/// so is exact.
fn spawn_at(
    path: &str,
    start_sec: f64,
    sample_rate: u32,
    channels: u16,
) -> Result<(Child, ChildStdout)> {
    const SEEK_MARGIN_SEC: f64 = 1.0;
    let coarse = (start_sec - SEEK_MARGIN_SEC).max(0.0);
    let fine = start_sec - coarse;

    let mut cmd = Command::new(resolve_bin("ffmpeg"));
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
    /// Set after a (re)spawn and cleared by the first read that follows. That
    /// read waits on ffmpeg's startup and container seek, so timing it would
    /// bias the throughput estimate down and push the strategy toward the
    /// respawns it is trying to avoid.
    fresh_spawn: bool,
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
            fresh_spawn: true,
        })
    }

    /// Reposition to `start_sec`, choosing whichever of the two available
    /// mechanisms is cheaper for the distance involved: reading the gap away on
    /// the running process, or killing it and spawning a new one already
    /// positioned there. See the seek-strategy comment above for the cost model.
    ///
    /// `margin_sec` is accepted for parity with `SymphoniaStream::seek_to` and
    /// ignored: it exists there to absorb a container seek that lands late, and
    /// ffmpeg's two-stage `-ss` is already sample-accurate.
    ///
    /// Callers see no behavioural difference between the two paths — both land
    /// on exactly `start_sec` — so this is purely a performance decision.
    pub fn seek_to(&mut self, start_sec: f64, _margin_sec: f64) -> Result<()> {
        if !start_sec.is_finite() || start_sec < 0.0 {
            return Err(anyhow::anyhow!(
                "start_sec must be a finite non-negative number, got {start_sec}"
            ));
        }
        let target_frame = (start_sec * self.sample_rate as f64).round() as u64;

        if target_frame >= self.next_output_frame {
            let gap_frames = target_frame - self.next_output_frame;
            let gap_secs = gap_frames as f64 / self.sample_rate.max(1) as f64;
            if prefers_read_forward(gap_secs, throughput_x()) {
                // Reading the gap away is projected to beat a respawn. A
                // failure here (EOF, a dead process) is not fatal — fall
                // through and respawn, which re-establishes the position from
                // scratch.
                if self.discard_frames(gap_frames).is_ok() {
                    return Ok(());
                }
            }
        }

        self.respawn_at(start_sec)
    }

    /// Kill the running process and start a new one emitting from `start_sec`.
    fn respawn_at(&mut self, start_sec: f64) -> Result<()> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let (child, stdout) = spawn_at(&self.path, start_sec, self.sample_rate, self.channels)?;
        self.child = child;
        self.stdout = stdout;
        self.next_output_frame = (start_sec * self.sample_rate as f64).round() as u64;
        self.fresh_spawn = true;
        Ok(())
    }

    /// Advance to `start_sec` by reading and discarding on the current
    /// process, no respawn. Errors if `start_sec` is behind the current
    /// position — the caller must `seek_to` instead.
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
        self.discard_frames(target_frame - self.next_output_frame)
    }

    /// Pull `frames` frames off the pipe and throw them away, advancing the
    /// position by exactly that much.
    ///
    /// Reads in fixed-size chunks rather than one buffer sized to the gap, and
    /// skips the f32 decode `read` does, since nothing here is kept. Individual
    /// chunk reads need not land on frame boundaries — only the total does, and
    /// the total is an exact multiple by construction.
    fn discard_frames(&mut self, frames: u64) -> Result<()> {
        if frames == 0 {
            return Ok(());
        }
        let bytes_per_frame = self.channels.max(1) as usize * 4;
        let total_bytes = frames * bytes_per_frame as u64;
        let mut buf = vec![0u8; DISCARD_CHUNK_BYTES.min(total_bytes as usize)];

        let start_frame = self.next_output_frame;
        let started = Instant::now();
        let mut consumed = 0u64;
        let mut outcome = Ok(());

        while consumed < total_bytes {
            let want = ((total_bytes - consumed).min(buf.len() as u64)) as usize;
            match self.stdout.read(&mut buf[..want]) {
                Ok(0) => {
                    outcome = Err(anyhow::anyhow!(
                        "EOF after skipping {} of {frames} frames",
                        consumed / bytes_per_frame as u64
                    ));
                    break;
                }
                Ok(n) => consumed += n as u64,
                Err(e) => {
                    outcome = Err(anyhow::anyhow!("ffmpeg stdout read failed while skipping: {e}"));
                    break;
                }
            }
        }

        // Advance by what was actually consumed, so a partial skip still leaves
        // the position honest. On the error paths the caller re-seeks anyway.
        self.next_output_frame = start_frame + consumed / bytes_per_frame as u64;

        if outcome.is_ok() && !self.fresh_spawn {
            record_throughput(frames as usize, self.sample_rate, started.elapsed());
        }
        self.fresh_spawn = false;
        outcome
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
        let started = Instant::now();
        while filled < buf.len() {
            match self.stdout.read(&mut buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(anyhow::anyhow!("ffmpeg stdout read failed: {e}")),
            }
        }
        let elapsed = started.elapsed();

        let whole_frames = filled / bytes_per_frame;
        let sample_count = whole_frames * ch;
        let mut samples = Vec::with_capacity(sample_count);
        for chunk in buf[..sample_count * 4].chunks_exact(4) {
            samples.push(f32::from_le_bytes(chunk.try_into().unwrap()));
        }

        self.next_output_frame += whole_frames as u64;
        // Feeds the same estimate `discard_frames` does — this is the seek
        // strategy's picture of how fast the gap between two columns can be
        // read away.
        if !self.fresh_spawn {
            record_throughput(whole_frames, self.sample_rate, elapsed);
        }
        self.fresh_spawn = false;

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

    /// Candidate list invariants: no duplicates (a directory on PATH that's
    /// also a hardcoded fallback must not be probed twice) and no empty
    /// entries (a trailing `:` in PATH yields one, which would resolve to a
    /// bare relative `ffmpeg`).
    #[test]
    fn candidate_dirs_are_unique_and_nonempty() {
        let dirs = candidate_dirs();
        let unique: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len(), "duplicate candidate directories");
        assert!(dirs.iter().all(|d| !d.as_os_str().is_empty()));
    }

    /// When ffmpeg is installed, detection must report an actual path to it —
    /// this is what the settings field shows to prove detection worked.
    #[test]
    fn detects_installed_ffmpeg() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg/ffprobe not found");
            return;
        }
        let found = detected_ffmpeg_path().expect("detection found nothing");
        assert!(Path::new(&found).is_file(), "detected path is not a file: {found}");
    }

    /// True when both `ffmpeg` and `ffprobe` are on PATH. Tests skip (rather
    /// than fail) when absent, since this is an optional runtime dependency,
    /// not a build dependency — CI/dev machines aren't guaranteed to have it.
    fn have_ffmpeg() -> bool {
        ffmpeg_available().is_ok()
    }

    /// Synthesize a short `.wma` fixture with `ffmpeg` itself, so no binary
    /// fixture needs to be committed to the repo.
    ///
    /// The pid keeps the path unique per test process: two `cargo test` runs at
    /// once would otherwise share these paths, and `ffmpeg -y` rewriting a
    /// fixture while the other run's decoder is streaming from it truncates that
    /// read into a spurious EOF.
    fn make_wma_fixture(name: &str, duration_secs: f64) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("{}_{name}", std::process::id()));
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

    /// The seek policy: short gaps are read away on the running process, long
    /// ones justify a respawn, and the boundary tracks measured throughput
    /// rather than sitting at a fixed number of seconds.
    #[test]
    fn seek_policy_reads_forward_only_when_it_is_cheaper() {
        // The case this whole change exists for: a whole-file overview of a
        // 6.7h file hops ~24s per column, and at a realistic throughput that is
        // far cheaper to read than to respawn for.
        assert!(prefers_read_forward(23.6, 1244.0));
        // The same hop on a machine decoding 50x slower is not.
        assert!(!prefers_read_forward(23.6, 25.0));
        // A 50h file's overview hops ~176s, past the crossover even when fast.
        assert!(!prefers_read_forward(176.0, 1244.0));
        // Fine-tier and playback gaps are never worth a respawn.
        assert!(prefers_read_forward(0.0, SEED_THROUGHPUT_X));
        assert!(prefers_read_forward(0.5, SEED_THROUGHPUT_X));

        // The boundary is exactly RESPAWN_COST_SEC worth of decoding, and moves
        // with throughput instead of being pinned to a duration.
        let x = 500.0;
        let crossover = RESPAWN_COST_SEC * x;
        assert!(prefers_read_forward(crossover * 0.99, x));
        assert!(!prefers_read_forward(crossover * 1.01, x));
        assert!(prefers_read_forward(crossover * 1.5, x * 2.0));

        // Degenerate inputs must not talk us into reading forward.
        assert!(!prefers_read_forward(f64::NAN, 1000.0));
        assert!(!prefers_read_forward(f64::INFINITY, 1000.0));
        assert!(!prefers_read_forward(-1.0, 1000.0));
        assert!(!prefers_read_forward(1.0, 0.0));
    }

    /// The throughput estimate must ignore the reads that would mislead it, and
    /// converge on the observed rate otherwise.
    #[test]
    fn throughput_estimate_ignores_unusable_samples() {
        let before = throughput_x();
        // Too short to be anything but syscall overhead.
        record_throughput(16, 44100, Duration::from_millis(1));
        assert_eq!(throughput_x(), before, "short read must not move the estimate");
        // Degenerate rate / zero elapsed.
        record_throughput(1 << 20, 0, Duration::from_millis(1));
        record_throughput(1 << 20, 44100, Duration::ZERO);
        assert_eq!(throughput_x(), before, "degenerate sample must not move the estimate");

        // A usable sample does move it, toward the observed value: 44100 frames
        // (1s of audio) taking 10ms is 100x realtime.
        record_throughput(44100, 44100, Duration::from_millis(10));
        let after = throughput_x();
        assert!(after > 0.0 && after.is_finite(), "estimate stayed sane: {after}");
        assert!(
            (after - before).abs() > f64::EPSILON || (before - 100.0).abs() < 1.0,
            "a usable sample should have moved the estimate ({before} -> {after})"
        );
    }

    /// Skipping a gap must advance by exactly the frames requested, however many
    /// `DISCARD_CHUNK_BYTES`-sized reads that takes.
    #[test]
    fn skip_to_advances_exactly_across_many_discard_chunks() {
        if !have_ffmpeg() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let path = make_wma_fixture("seenote_wma_skip_chunks.wma", 6.0);
        let mut stream = FfmpegStream::open(path.to_str().unwrap(), 0.0).expect("open");

        // 4s at 44.1kHz mono f32 is ~706KB — around 11 discard chunks.
        stream.skip_to(4.0).expect("skip_to");
        assert_eq!(stream.position_frames(), (4.0 * 44100.0) as u64);

        // And it still yields audio from there rather than having desynced.
        let (_, n) = stream.read(1024).expect("read");
        assert_eq!(n, 1024, "expected audio to continue after the skip");

        assert!(stream.skip_to(3.0).is_err(), "skip_to must refuse to go backwards");
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
