pub mod decoder;
pub mod ffmpeg_stream;
pub mod fft;
pub mod spectrogram;
pub mod stream_pool;
pub mod wav;

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Lock a global cache, recovering the data if a panicking thread poisoned it.
/// These mutexes guard caches and registries whose contents stay valid across a
/// panic, so one bad decode must not disable the cache (or every later command)
/// for the rest of the session.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
