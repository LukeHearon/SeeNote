//! Reuse of decoder streams across spectrogram chunk requests.
//!
//! ── The problem ──────────────────────────────────────────────────────────────
//! Opening a `PcmStream` at time T scans the container from byte 0 to T, because
//! MP3 carries no seek index. That cost grows with depth into the file, and it
//! is paid per request. Measured on a 49.7h MP3 (`coarse_bench`), a fine-tier
//! chunk 45h in took 310ms, of which only ~9ms was the decode and FFT it
//! actually needed — 35x more spent reaching the audio than processing it. On a
//! cold or external disk that scan is real I/O: a four-chunk viewport read
//! ~3.6GB to show 48 seconds of audio.
//!
//! ── The fix ──────────────────────────────────────────────────────────────────
//! Forward seeks on an already-open stream resume the scan from the stream's
//! current position (see `decoder::seek_bench`), so a stream left just before
//! the next request's start reaches it almost for free. This pool keeps recently
//! used streams and hands out one positioned at or before the requested time,
//! turning the common access patterns — panning, playback, successively loading
//! a viewport's chunks — into short forward seeks instead of full re-scans.
//!
//! A stream is only reused when its position is *at or before* the target: a
//! backward seek would restart the scan from byte 0, which is what we are
//! avoiding. When nothing suitable is idle, the caller opens a fresh stream, so
//! the pool can only make things faster, never slower.
//!
//! How a reused stream advances depends on the distance, because `seek_to` aims
//! `margin_sec` before its target: a stream already inside that margin would be
//! seeking *backwards*, at full rescan cost. So a stream further back than the
//! margin seeks (microseconds), and one already inside it skips forward by
//! reading (also microseconds, bounded by the margin).
//!
//! ── Staleness ────────────────────────────────────────────────────────────────
//! A pooled stream holds an open handle and buffered container state, so it
//! would keep serving the old content if the file were rewritten underneath it.
//! Idle streams are therefore dropped after `POOL_TTL`, keeping any such window
//! short, and the pool is capped so it cannot accumulate handles.

use super::decoder::PcmStream;
use anyhow::Result;
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long an unused stream stays reusable. Short enough that a file edited on
/// disk is not served from a stale handle for long, long enough to cover the
/// gaps between viewport loads while panning or playing.
const POOL_TTL: Duration = Duration::from_secs(30);

/// Idle streams kept per file. Matches the frontend's concurrent-request limit
/// so a viewport's worth of parallel requests can each find one next time.
const MAX_STREAMS_PER_PATH: usize = 4;

/// Files tracked at once. Switching tracks should not strand handles.
const MAX_PATHS: usize = 3;

struct Idle {
    stream: PcmStream,
    last_used: Instant,
}

type Pool = HashMap<String, Vec<Idle>>;

fn pool() -> &'static Mutex<Pool> {
    static POOL: OnceLock<Mutex<Pool>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reap(pool: &mut Pool) {
    let now = Instant::now();
    for streams in pool.values_mut() {
        streams.retain(|idle| now.duration_since(idle.last_used) < POOL_TTL);
    }
    pool.retain(|_, streams| !streams.is_empty());
}

/// A checked-out stream that returns itself to the pool when dropped.
///
/// Checkout REMOVES the stream from the pool, so a stream is never shared
/// between threads mid-read; concurrent requests either find separate idle
/// streams or open their own.
pub struct PooledStream {
    path: String,
    stream: Option<PcmStream>,
}

impl Deref for PooledStream {
    type Target = PcmStream;
    fn deref(&self) -> &PcmStream {
        self.stream.as_ref().expect("stream taken only on drop")
    }
}

impl DerefMut for PooledStream {
    fn deref_mut(&mut self) -> &mut PcmStream {
        self.stream.as_mut().expect("stream taken only on drop")
    }
}

impl Drop for PooledStream {
    fn drop(&mut self) {
        let Some(stream) = self.stream.take() else { return };
        let Ok(mut pool) = pool().lock() else { return };
        reap(&mut pool);

        let entry = pool.entry(self.path.clone()).or_default();
        entry.push(Idle { stream, last_used: Instant::now() });
        // Keep the most recently used; a stream that keeps losing the race for
        // reuse is the least useful one to hold a handle for.
        if entry.len() > MAX_STREAMS_PER_PATH {
            entry.remove(0);
        }

        // Bound total files. Evict whichever path was least recently returned to.
        while pool.len() > MAX_PATHS {
            let victim = pool
                .iter()
                .max_by_key(|(_, streams)| {
                    streams.iter().map(|i| i.last_used).min().unwrap_or_else(Instant::now)
                })
                .map(|(path, _)| path.clone());
            match victim {
                Some(path) => {
                    pool.remove(&path);
                }
                None => break,
            }
        }
    }
}

/// Get a stream for `path` positioned at `start_sec`, reusing an idle one when
/// that only requires seeking forward, otherwise opening a new one.
///
/// `margin_sec` is passed through to the seek (see `PcmStream::seek_to`); it
/// only affects how much audio is decoded and discarded on the way, never where
/// the stream lands.
pub fn acquire(path: &str, start_sec: f64, margin_sec: f64) -> Result<PooledStream> {
    let reused = take_forward_candidate(path, start_sec);

    let stream = match reused {
        Some(mut stream) => {
            let advanced = if stream.position_secs() <= start_sec - margin_sec {
                stream.seek_to(start_sec, margin_sec)
            } else {
                stream.skip_to(start_sec)
            };
            match advanced {
                Ok(()) => stream,
                // A pooled stream that cannot be advanced (file replaced,
                // truncated, EOF) must not poison the request — open fresh.
                Err(_) => PcmStream::open(path, start_sec)?,
            }
        }
        None => PcmStream::open(path, start_sec)?,
    };

    Ok(PooledStream { path: path.to_string(), stream: Some(stream) })
}

/// Remove and return the idle stream for `path` that is closest to `start_sec`
/// without being past it — the one whose forward seek scans the least.
fn take_forward_candidate(path: &str, start_sec: f64) -> Option<PcmStream> {
    let mut pool = pool().lock().ok()?;
    reap(&mut pool);
    let streams = pool.get_mut(path)?;

    let best = streams
        .iter()
        .enumerate()
        .filter(|(_, idle)| idle.stream.position_secs() <= start_sec)
        .max_by(|(_, a), (_, b)| {
            a.stream
                .position_secs()
                .partial_cmp(&b.stream.position_secs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)?;

    let idle = streams.remove(best);
    if streams.is_empty() {
        pool.remove(path);
    }
    Some(idle.stream)
}

/// Drop every pooled stream. Used by tests that need a cold pool.
#[cfg(test)]
pub fn clear() {
    if let Ok(mut pool) = pool().lock() {
        pool.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mono 16-bit WAV ramp, so a stream's position is verifiable from the
    /// samples it returns.
    fn write_ramp_wav(name: &str, sample_rate: u32, n_frames: usize) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let data_bytes = (n_frames * 2) as u32;
        let mut wav: Vec<u8> = Vec::with_capacity(44 + data_bytes as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        for i in 0..n_frames {
            wav.extend_from_slice(&((i % 30000) as i16).to_le_bytes());
        }
        std::fs::write(&path, wav).expect("write ramp wav");
        path
    }

    fn ramp_value(i: usize) -> f32 {
        (i % 30000) as f32 / 32768.0
    }

    /// Whether a stream came from the pool or was freshly opened, the samples it
    /// returns must be the ones at the requested time.
    #[test]
    fn reused_streams_land_where_a_fresh_open_would() {
        clear();
        let sr = 8000u32;
        let path = write_ramp_wav("seenote_pool_positions.wav", sr, 80_000);
        let p = path.to_str().unwrap();

        // Walk forward, releasing each stream back to the pool. Every step after
        // the first should be served by reuse, and all must be sample-exact.
        for start_sec in [0.0, 1.0, 2.5, 2.5, 6.0, 9.99] {
            let mut stream = acquire(p, start_sec, 0.05).expect("acquire");
            let expected = (start_sec * sr as f64) as usize;
            let (samples, n) = stream.read(4).expect("read");
            assert_eq!(n, 4, "short read at {start_sec}s");
            for (i, &v) in samples.iter().enumerate() {
                assert!(
                    (v - ramp_value(expected + i)).abs() < 1e-6,
                    "at {start_sec}s frame +{i}: got {v}, want {}",
                    ramp_value(expected + i)
                );
            }
        }
        clear();
        let _ = std::fs::remove_file(&path);
    }

    /// A stream is reusable only for targets at or after its position; seeking
    /// backward would restart the container scan, which is the cost the pool
    /// exists to avoid.
    #[test]
    fn only_streams_positioned_before_the_target_are_reused() {
        clear();
        let sr = 8000u32;
        let path = write_ramp_wav("seenote_pool_forward_only.wav", sr, 80_000);
        let p = path.to_str().unwrap();

        // Leave one stream parked at 5s.
        {
            let mut stream = acquire(p, 5.0, 0.05).expect("acquire");
            let _ = stream.read(8).expect("read");
        }
        // A target before it must not take that stream...
        assert!(take_forward_candidate(p, 1.0).is_none());
        // ...but one after it may.
        let candidate = take_forward_candidate(p, 7.0);
        assert!(candidate.is_some());
        assert!(candidate.unwrap().position_secs() <= 7.0);

        clear();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pool_is_bounded_per_path() {
        clear();
        let sr = 8000u32;
        let path = write_ramp_wav("seenote_pool_bounded.wav", sr, 80_000);
        let p = path.to_str().unwrap();

        // Hold several at once so they cannot be reused, then release them all.
        let held: Vec<_> = (0..MAX_STREAMS_PER_PATH + 3)
            .map(|i| acquire(p, i as f64, 0.05).expect("acquire"))
            .collect();
        drop(held);

        let count = pool().lock().unwrap().get(p).map(|v| v.len()).unwrap_or(0);
        assert_eq!(count, MAX_STREAMS_PER_PATH);

        clear();
        let _ = std::fs::remove_file(&path);
    }
}
