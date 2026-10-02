//! 16-bit PCM WAV writing: the audio-range export, and the fixtures tests
//! decode.

use std::io::Write;
use std::path::Path;

/// Largest data payload a RIFF/WAV header can describe: sizes are u32 and the
/// RIFF chunk size also counts the 36 header bytes after "RIFF"+size.
pub const MAX_WAV_DATA_BYTES: u64 = u32::MAX as u64 - 36;

/// Write a PCM buffer as a 16-bit-PCM WAV file. Standard 44-byte header.
/// Errors, rather than writing a header whose sizes have wrapped, when the data
/// would not fit in a WAV (over ~4 GiB).
pub fn write_wav_i16(path: &Path, sample_rate: u32, channels: u16, samples: &[i16]) -> std::io::Result<()> {
    let data_bytes = samples.len() as u64 * 2;
    if data_bytes > MAX_WAV_DATA_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "audio is too long to export as WAV (over 4 GiB); export a shorter range",
        ));
    }
    let data_bytes = data_bytes as u32;
    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_bytes).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&channels.to_le_bytes())?;
    out.write_all(&sample_rate.to_le_bytes())?;
    out.write_all(&(sample_rate * channels as u32 * 2).to_le_bytes())?; // byte rate
    out.write_all(&(channels * 2).to_le_bytes())?; // block align
    out.write_all(&16u16.to_le_bytes())?; // bits per sample
    out.write_all(b"data")?;
    out.write_all(&data_bytes.to_le_bytes())?;
    for &s in samples {
        out.write_all(&s.to_le_bytes())?;
    }
    out.flush()
}


/// Write a 16-bit WAV fixture to the temp dir, `sample(frame, channel)` giving
/// each value, and return its path. The pid keeps the path unique per test
/// process, so concurrent `cargo test` runs cannot rewrite each other's fixture.
#[cfg(test)]
pub(crate) fn write_test_wav(
    name: &str,
    sample_rate: u32,
    channels: u16,
    n_frames: usize,
    sample: impl Fn(usize, usize) -> i16,
) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("{}_{name}", std::process::id()));
    let ch = channels as usize;
    let samples: Vec<i16> = (0..n_frames * ch).map(|i| sample(i / ch, i % ch)).collect();
    write_wav_i16(&path, sample_rate, channels, &samples).expect("write test wav");
    path
}

/// Mono fixture whose frame i holds i (wrapping at 30000 to stay inside i16), so
/// a position is verifiable from the samples a stream returns.
#[cfg(test)]
pub(crate) fn write_ramp_wav(name: &str, sample_rate: u32, n_frames: usize) -> std::path::PathBuf {
    write_test_wav(name, sample_rate, 1, n_frames, |i, _| (i % 30000) as i16)
}
