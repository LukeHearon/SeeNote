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
/// How expensive is a SMALL BACKWARD seek? The stream pool can only reuse a
/// stream positioned at or before the target, and readers routinely
/// overshoot the next request's start by a few tens of milliseconds, so the
/// answer decides whether those streams are reusable.
#[test]
#[ignore]
fn backward_seek_cost() {
    let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
    let info = get_file_info(&path).expect("info");
    let deep = info.duration_secs * 0.9;

    let mut s = PcmStream::open(&path, deep).expect("open");
    let _ = s.read(2048).expect("read");

    for back in [0.05f64, 0.5, 5.0, 60.0] {
        // Re-establish a known position, then step back by `back`.
        s.seek_to(deep, DEFAULT_SEEK_MARGIN_SEC).expect("fwd");
        let _ = s.read(2048).expect("read");
        let t = Instant::now();
        s.seek_to(deep - back, DEFAULT_SEEK_MARGIN_SEC).expect("back");
        let _ = s.read(2048).expect("read");
        println!("backward {back:>6}s from {deep:.0}s: {:?}", t.elapsed());
    }

    // Reference: a forward seek of the same magnitudes.
    for fwd in [0.05f64, 0.5, 5.0, 60.0] {
        s.seek_to(deep, DEFAULT_SEEK_MARGIN_SEC).expect("reset");
        let _ = s.read(2048).expect("read");
        let t = Instant::now();
        s.seek_to(deep + fwd, DEFAULT_SEEK_MARGIN_SEC).expect("fwd");
        let _ = s.read(2048).expect("read");
        println!("forward  {fwd:>6}s from {deep:.0}s: {:?}", t.elapsed());
    }
}

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
            s.seek_to(target, DEFAULT_SEEK_MARGIN_SEC).expect("seek_to");
            let _ = s.read(2048).expect("read");
        }
        let total = t.elapsed();
        println!("{n} forward seek_to on one stream: {total:?} total, {:?}/column",
                 total / n as u32);
    }
}
