//! Shared helpers used by more than one command module: the media-extension
//! tables, the atomic file-write primitive, and a generic recursive
//! file-walker. Keeping these in one place avoids the divergence that comes
//! from maintaining parallel copies.

use std::path::Path;

/// Audio file extensions SeeNote recognizes (lowercase, no leading dot).
/// `wma` decodes via a system ffmpeg/ffprobe binary rather than symphonia (see
/// `audio::ffmpeg_stream`) — it's still listed here since the file is real
/// audio, but opening it fails with an actionable error on machines without
/// ffmpeg installed.
pub const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "aac", "m4a", "wma"];
/// Video file extensions SeeNote recognizes (lowercase, no leading dot).
pub const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v"];

/// Canonical on-disk extension for internal annotation files (lowercase, no
/// leading dot). Annotations use one shared internal format (currently Audacity
/// tab-delimited `.txt`); this is NOT user-configurable. May become `yaml` in a
/// future format migration — change it here and in the TS mirror
/// `ANNOTATION_FILE_EXT` (constants.ts). `git_sync` uses this to decide which
/// files get the semantic set-merge and which are staged for sync.
pub const ANNOTATION_EXT: &str = "txt";

/// Write `content` to `path` atomically: stage to a uniquely named sibling temp
/// file, fsync it, then rename over the target, so that a crash mid-write never
/// leaves the file truncated or corrupt and concurrent writers never share a
/// temp file. On failure the temp file is removed best-effort.
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let tmp_path = {
        let mut t = path.to_path_buf();
        let mut name = t.file_name().unwrap_or_default().to_os_string();
        name.push(format!(
            ".{}.{}.tmp",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        t.set_file_name(name);
        t
    };

    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to write temp file '{}': {}", tmp_path.display(), e));
    }

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

/// True if following the symlink `link` found in directory `dir` would loop
/// (its target is `dir` itself or one of its ancestors) or can't be resolved.
/// Symlinked directories are otherwise followed, since users link media folders
/// in from elsewhere.
pub fn symlink_dir_loops(dir: &Path, link: &Path) -> bool {
    match (dir.canonicalize(), link.canonicalize()) {
        (Ok(d), Ok(l)) => d.starts_with(&l),
        _ => true,
    }
}

/// Recursively walk `dir`, invoking `visit` for every non-directory entry.
/// Directories are descended into unconditionally, except symlinks that would
/// loop back on an ancestor; unreadable directories are silently skipped.
/// Entries are visited in the filesystem's `read_dir` order.
pub fn walk_files<F: FnMut(&Path)>(dir: &Path, visit: &mut F) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_symlink = entry.file_type().is_ok_and(|t| t.is_symlink());
        if path.is_dir() {
            if is_symlink && symlink_dir_loops(dir, &path) {
                continue;
            }
            walk_files(&path, visit);
        } else {
            visit(&path);
        }
    }
}

/// Create a fresh, uniquely named temp directory for a test.
#[cfg(test)]
pub(crate) fn make_tmp_root(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir()
        .join(format!("seenote_test_{tag}_{}_{nanos}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create tmp root");
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp() {
        let root = make_tmp_root("atomic");
        let p = root.join("f.json");
        atomic_write(&p, "one").unwrap();
        atomic_write(&p, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let names: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().collect();
        assert_eq!(names.len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn walk_files_survives_symlink_loops() {
        let root = make_tmp_root("walkloop");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/f.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&root, root.join("a/b/up")).unwrap();
        std::os::unix::fs::symlink(root.join("a"), root.join("a/self")).unwrap();
        let mut seen = vec![];
        walk_files(&root, &mut |p| seen.push(p.to_path_buf()));
        assert_eq!(seen.len(), 1, "{seen:?}");
        std::fs::remove_dir_all(&root).ok();
    }
}
