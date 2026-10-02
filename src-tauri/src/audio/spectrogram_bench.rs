use super::*;
use std::time::Instant;

/// Wall-clock cost of the coarse (sampled) spectrogram path on a real long
/// file. #[ignore]d — needs a fixture:
///   SEEK_BENCH_FILE=/path/to/long.mp3 \
///     cargo test --release coarse_bench -- --ignored --nocapture
/// Does batching a contiguous run into one forward walk beat fetching the
/// chunks in parallel, each on its own stream? Batching does strictly less
/// I/O (one container pass instead of one per chunk, each from byte 0) but
/// serializes CPU that would otherwise run on several cores.
#[test]
#[ignore]
fn range_walk_vs_parallel_chunks() {
    let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
    let info = decoder::get_file_info(&path).expect("info");
    let sr = info.sample_rate as usize;
    // The whole-file view of this file: 4 chunks of 1024 columns.
    let hop = 2_097_152usize;
    let chunk_duration = 1024.0 * hop as f64 / sr as f64;
    let n_chunks = 4u32;

    // A: four independent chunk computations, in parallel.
    let t = Instant::now();
    std::thread::scope(|scope| {
        for i in 0..n_chunks {
            let path = path.clone();
            scope.spawn(move || {
                let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                    path,
                    start_sec: i as f64 * chunk_duration,
                    duration_sec: chunk_duration,
                    fft_size: 2048,
                    hop_size: hop,
                });
            });
        }
    });
    println!("parallel per-chunk ({n_chunks} chunks): {:?}", t.elapsed());

    // B: one forward walk covering the same range.
    let t = Instant::now();
    let n_freq_bins = 1024usize;
    let mut stream = decoder::PcmStream::open(&path, 0.0).expect("open");
    for i in 0..n_chunks {
        let start_sec = i as f64 * chunk_duration;
        let (n_cols, _) = coarse_geometry(
            start_sec, chunk_duration, info.duration_secs, hop, info.sample_rate,
        );
        let mut output = vec![0u16; n_cols * n_freq_bins];
        let _ = coarse_columns(
            &mut stream, &mut output, n_cols, n_freq_bins,
            start_sec, hop, 2048, info.sample_rate, i > 0,
        );
    }
    println!("single forward walk ({n_chunks} chunks): {:?}", t.elapsed());

    // C: split into parallel walks of `per` chunks each.
    for per in [2u32, 1] {
        let t = Instant::now();
        std::thread::scope(|scope| {
            for w in 0..(n_chunks / per) {
                let path = path.clone();
                scope.spawn(move || {
                    let first = w * per;
                    let mut stream =
                        decoder::PcmStream::open(&path, first as f64 * chunk_duration).unwrap();
                    for i in 0..per {
                        let start_sec = (first + i) as f64 * chunk_duration;
                        let (n_cols, _) = coarse_geometry(
                            start_sec, chunk_duration, info.duration_secs, hop, info.sample_rate,
                        );
                        let mut output = vec![0u16; n_cols * 1024];
                        let _ = coarse_columns(
                            &mut stream, &mut output, n_cols, 1024,
                            start_sec, hop, 2048, info.sample_rate, i > 0,
                        );
                    }
                });
            }
        });
        println!("{} parallel walks of {per} chunks: {:?}", n_chunks / per, t.elapsed());
    }
}

/// Fine-tier chunk cost at increasing depth into a long file. Each chunk
/// opens its own decoder, and the container open scans from byte 0.
#[test]
#[ignore]
fn fine_chunk_cost_by_depth() {
    let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
    let info = decoder::get_file_info(&path).expect("info");
    let sr = info.sample_rate as usize;
    let hop = 512usize;
    let chunk_duration = 1024.0 * hop as f64 / sr as f64;
    println!("fine chunk = {chunk_duration:.1}s");

    for frac in [0.0, 0.1, 0.5, 0.9] {
        let start = info.duration_secs * frac;
        let t = Instant::now();
        let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
            path: path.clone(),
            start_sec: start,
            duration_sec: chunk_duration,
            fft_size: 2048,
            hop_size: hop,
        }).expect("chunk");
        println!("  fine chunk @ {start:8.0}s: {:?}", t.elapsed());
    }

    // Panning deep in the file: consecutive chunks, one after another.
    // Without stream reuse each pays its own full container scan.
    let base = info.duration_secs * 0.9;
    for reuse in [false, true] {
        let label = if reuse { "with stream reuse" } else { "no reuse" };
        stream_pool::clear();
        let t = Instant::now();
        for i in 0..6 {
            if !reuse {
                stream_pool::clear(); // force a fresh open per chunk
            }
            let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                path: path.clone(),
                start_sec: base + i as f64 * chunk_duration,
                duration_sec: chunk_duration,
                fft_size: 2048,
                hop_size: hop,
            }).expect("chunk");
        }
        let el = t.elapsed();
        println!("  6 sequential fine chunks @ {base:.0}s ({label}): {el:?} total, {:?}/chunk", el / 6);
    }

    // Four such chunks (a typical zoomed-in viewport) in parallel, deep in.
    let base = info.duration_secs * 0.9;
    let t = Instant::now();
    std::thread::scope(|scope| {
        for i in 0..4 {
            let path = path.clone();
            scope.spawn(move || {
                let _ = compute_spectrogram_chunk(&SpectrogramChunkRequest {
                    path,
                    start_sec: base + i as f64 * chunk_duration,
                    duration_sec: chunk_duration,
                    fft_size: 2048,
                    hop_size: hop,
                });
            });
        }
    });
    println!("  4 parallel fine chunks @ {base:.0}s: {:?}", t.elapsed());
}

/// Phase breakdown for one coarse chunk: seek vs decode vs FFT.
#[test]
#[ignore]
fn coarse_phase_breakdown() {
    let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
    let info = decoder::get_file_info(&path).expect("info");
    let sr = info.sample_rate as usize;
    let fft_size = 2048usize;
    let hop = 2_097_152usize; // coarsest selected tier for a 50h file
    let n_cols = 64usize;     // sample of a 1024-col chunk
    // One FFT window per column, matching what coarse tiers do since pooling
    // was dropped.
    let pool_frames = fft_size;
    println!("sr={sr} pool_frames={pool_frames} hop={hop}");

    let mut stream = decoder::PcmStream::open(&path, 0.0).expect("open");
    let ch = stream.channels().max(1) as usize;
    let mut mono = vec![0.0f32; pool_frames];
    let (mut t_seek, mut t_read, mut t_fft) = (
        std::time::Duration::ZERO, std::time::Duration::ZERO, std::time::Duration::ZERO);

    for col in 0..n_cols {
        let t = (col * hop) as f64 / sr as f64;
        let t0 = Instant::now();
        if col > 0 && stream.seek_to(t, COARSE_SEEK_MARGIN_SEC).is_err() { break; }
        t_seek += t0.elapsed();

        let t0 = Instant::now();
        let mut filled = 0usize;
        while filled < pool_frames {
            let (inter, n) = match stream.read(pool_frames - filled) { Ok(r) => r, Err(_) => break };
            if n == 0 { break; }
            for f in 0..n {
                let mut sum = 0.0f32;
                for c in 0..ch { sum += inter[f * ch + c]; }
                mono[filled + f] = sum / ch as f32;
            }
            filled += n;
        }
        t_read += t0.elapsed();

        let t0 = Instant::now();
        let _ = fft::compute_stft(&mono[..filled], fft_size, fft_size);
        t_fft += t0.elapsed();
    }
    println!("{n_cols} cols: seek {t_seek:?}, read+mixdown {t_read:?}, fft {t_fft:?}");
    println!("=> per 1024-col chunk: seek {:?}, read {:?}, fft {:?}",
             t_seek * 16, t_read * 16, t_fft * 16);
}

/// End-to-end cost of the whole-file overview — the one request a user
/// sits and waits on when a long file is first opened.
///
/// Derives the hop from the fixture's own length instead of hardcoding one,
/// so it exercises the real coarsest tier for any file. That matters for
/// `.wma`, where the backend is a subprocess and the per-column seek
/// strategy (read forward vs. respawn ffmpeg) decides the whole cost:
///
///   SEEK_BENCH_FILE=/path/to/long.wma \
///     cargo test --release overview_build_cost -- --ignored --nocapture
#[test]
#[ignore]
fn overview_build_cost() {
    let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
    let info = decoder::get_file_info(&path).expect("info");
    let hop = ((info.duration_secs * info.sample_rate as f64) / 1024.0).max(1.0) as usize;
    println!(
        "dur={:.0}s sr={} hop={hop} (~1024 cols spanning the whole file)",
        info.duration_secs, info.sample_rate
    );

    let t = Instant::now();
    let blob = compute_spectrogram_chunk(&SpectrogramChunkRequest {
        path,
        start_sec: 0.0,
        duration_sec: info.duration_secs,
        fft_size: 2048,
        hop_size: hop,
    })
    .expect("chunk");
    println!("whole-file overview: {:?} ({} bytes)", t.elapsed(), blob.len());
}

#[test]
#[ignore]
fn coarse_chunk_cost() {
    let path = std::env::var("SEEK_BENCH_FILE").expect("set SEEK_BENCH_FILE");
    let info = decoder::get_file_info(&path).expect("info");
    let sr = info.sample_rate as usize;

    for (label, hop, dur) in [
        ("tier0 hop=1s  chunk=600s", sr, 600.0),
        ("hop=44s       chunk=512col", sr * 44, 512.0 * 44.0),
    ] {
        for start in [0.0, info.duration_secs * 0.5] {
            let req = SpectrogramChunkRequest {
                path: path.clone(),
                start_sec: start,
                duration_sec: dur,
                fft_size: 2048,
                hop_size: hop,
            };
            let t = Instant::now();
            let bytes = compute_spectrogram_chunk(&req).expect("chunk");
            let n_cols = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
            println!("{label} @ {start:.0}s: {:?} ({n_cols} cols)", t.elapsed());
        }
    }
}
