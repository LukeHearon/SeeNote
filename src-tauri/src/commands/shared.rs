//! Shared helpers used by more than one command module: the media-extension
//! tables, the atomic file-write primitive, and a generic recursive
//! file-walker. Keeping these in one place avoids the divergence that comes
//! from maintaining parallel copies.

use std::path::Path;

/// Audio file extensions SeeNote recognizes (lowercase, no leading dot).
pub const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "aac", "m4a"];
/// Video file extensions SeeNote recognizes (lowercase, no leading dot).
pub const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v"];

/// Write `content` to `path` atomically: stage to a sibling `.tmp` file then
/// rename over the target, so that a crash mid-write never leaves the file
/// truncated or corrupt. On rename failure the temp file is removed
/// best-effort before the error is returned.
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let tmp_path = {
        let mut t = path.to_path_buf();
        let mut name = t.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        t.set_file_name(name);
        t
    };

    std::fs::write(&tmp_path, content).map_err(|e| {
        format!("failed to write temp file '{}': {}", tmp_path.display(), e)
    })?;

    if let Err(rename_err) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "failed to rename '{}' to '{}': {}",
            tmp_path.display(),
            path.display(),
            rename_err
        ));
    }

    Ok(())
}

/// Recursively walk `dir`, invoking `visit` for every non-directory entry.
/// Directories are descended into unconditionally; unreadable directories are
/// silently skipped (matching the previous `read_dir(..).flatten()` callers).
/// The order in which entries are visited follows the filesystem's
/// `read_dir` order, exactly as before.
pub fn walk_files<F: FnMut(&Path)>(dir: &Path, visit: &mut F) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, visit);
        } else {
            visit(&path);
        }
    }
}
