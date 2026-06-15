use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::shared::{atomic_write, AUDIO_EXTS, VIDEO_EXTS};

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_audio: bool,
    pub is_video: bool,
}

fn classify_ext(path: &std::path::Path) -> (bool, bool) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    match ext.as_deref() {
        Some(e) if AUDIO_EXTS.contains(&e) => (true, false),
        Some(e) if VIDEO_EXTS.contains(&e) => (false, true),
        _ => (false, false),
    }
}

/// Canonicalize `path` and verify it is a descendant of at least one root in
/// `allowed_roots`.  Returns `Err` if any canonicalization fails or if the path
/// escapes all roots.  When `allowed_roots` is empty the check is skipped so
/// that call-sites that haven't yet been migrated remain functional.
fn assert_within_roots(path: &std::path::Path, allowed_roots: &[String]) -> Result<std::path::PathBuf, String> {
    let canonical = path.canonicalize().map_err(|e| format!("cannot resolve path '{}': {}", path.display(), e))?;
    if allowed_roots.is_empty() {
        return Ok(canonical);
    }
    for root_str in allowed_roots {
        let root = std::path::Path::new(root_str);
        let canonical_root = root.canonicalize().map_err(|e| format!("cannot resolve root '{}': {}", root_str, e))?;
        if canonical.starts_with(&canonical_root) {
            return Ok(canonical);
        }
    }
    Err(format!("path '{}' is outside the allowed project directories", path.display()))
}

#[tauri::command]
pub async fn list_directory(path: String, allowed_roots: Option<Vec<String>>) -> Result<Vec<DirEntry>, String> {
    let roots = allowed_roots.unwrap_or_default();
    let dir_path = std::path::Path::new(&path);
    let dir = assert_within_roots(dir_path, &roots)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;

    let mut result: Vec<DirEntry> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            // Skip hidden files
            if name.starts_with('.') {
                return None;
            }
            let is_dir = p.is_dir();
            let (is_audio, is_video) = classify_ext(&p);
            Some(DirEntry {
                path: p.to_string_lossy().to_string(),
                name,
                is_dir,
                is_audio,
                is_video,
            })
        })
        .collect();

    // Sort: directories first, then by name
    result.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String, allowed_roots: Option<Vec<String>>) -> Result<(), String> {
    let target = std::path::Path::new(&path);

    // Ensure parent directories exist before we try to canonicalize the target
    // (the file itself may not exist yet).
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Sandboxing: canonicalize the parent (the file doesn't exist yet) and
    // verify it descends from an allowed root.
    let roots = allowed_roots.unwrap_or_default();
    if !roots.is_empty() {
        // Use the parent directory for the existence check since the file may be new.
        let check_path = if target.exists() {
            target.to_path_buf()
        } else {
            target.parent()
                .unwrap_or(target)
                .to_path_buf()
        };
        assert_within_roots(&check_path, &roots)?;
    }

    // Atomic write: write to a sibling .tmp file then rename over the target.
    atomic_write(target, &content)
}

#[tauri::command]
pub async fn read_text_file(path: String, allowed_roots: Option<Vec<String>>) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&path);
    let roots = allowed_roots.unwrap_or_default();
    if !roots.is_empty() && p.exists() {
        assert_within_roots(p, &roots)?;
    }
    if p.exists() {
        std::fs::read_to_string(p)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn open_directory_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app.dialog().file().blocking_pick_folder();

    Ok(result.and_then(|p| match p {
        FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
        _ => None,
    }))
}

#[tauri::command]
pub async fn open_directory_dialog_at(app: tauri::AppHandle, start_path: String) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();
    let p = std::path::Path::new(&start_path);
    if p.is_dir() {
        builder = builder.set_directory(p);
    }
    let result = builder.blocking_pick_folder();

    Ok(result.and_then(|p| match p {
        FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
        _ => None,
    }))
}

/// Open a native single-file picker, optionally seeded at `start_path`'s
/// directory and constrained by `filters`. Returns the chosen absolute path,
/// or `None` if the user cancelled. Mirrors `save_file_dialog` but for reads.
#[tauri::command]
pub async fn open_file_dialog(
    app: tauri::AppHandle,
    start_path: Option<String>,
    filters: Vec<DialogFilter>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(sp) = start_path.as_deref() {
        let p = std::path::Path::new(sp);
        let dir = if p.is_dir() { Some(p) } else { p.parent() };
        if let Some(d) = dir {
            if d.is_dir() {
                dialog = dialog.set_directory(d);
            }
        }
    }
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(&f.name, &exts);
    }

    let result = dialog.blocking_pick_file();

    Ok(result.and_then(|p| match p {
        FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
        _ => None,
    }))
}

/// Multi-select variant of `open_file_dialog`. Returns the chosen absolute
/// paths, or `None` if the user cancelled.
#[tauri::command]
pub async fn open_files_dialog(
    app: tauri::AppHandle,
    start_path: Option<String>,
    filters: Vec<DialogFilter>,
) -> Result<Option<Vec<String>>, String> {
    let mut dialog = app.dialog().file();
    if let Some(sp) = start_path.as_deref() {
        let p = std::path::Path::new(sp);
        let dir = if p.is_dir() { Some(p) } else { p.parent() };
        if let Some(d) = dir {
            if d.is_dir() {
                dialog = dialog.set_directory(d);
            }
        }
    }
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(&f.name, &exts);
    }

    let result = dialog.blocking_pick_files();

    Ok(result.map(|paths| {
        paths
            .into_iter()
            .filter_map(|p| match p {
                FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
                _ => None,
            })
            .collect()
    }))
}

#[tauri::command]
pub async fn list_media_files_recursive(path: String) -> Result<Vec<String>, String> {
    let root = std::path::Path::new(&path);
    let mut files = Vec::new();
    collect_media_files(root, &mut files).map_err(|e| e.to_string())?;
    files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(files)
}

fn collect_media_files(dir: &std::path::Path, files: &mut Vec<String>) -> std::io::Result<()> {
    let read_dir_iter = match std::fs::read_dir(dir) {
        Ok(iter) => iter,
        Err(e) => {
            eprintln!("[SeeNote] collect_media_files: cannot read dir '{}': {}", dir.display(), e);
            return Ok(());
        }
    };
    for entry_result in read_dir_iter {
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[SeeNote] collect_media_files: error reading entry in '{}': {}", dir.display(), e);
                continue;
            }
        };
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if let Err(e) = collect_media_files(&path, files) {
                eprintln!("[SeeNote] collect_media_files: error descending into '{}': {}", path.display(), e);
            }
        } else {
            let (is_audio, is_video) = classify_ext(&path);
            if is_audio || is_video {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn check_dir_exists(path: String) -> Result<bool, String> {
    let p = std::path::Path::new(&path);
    Ok(p.is_dir())
}

#[tauri::command]
pub async fn remove_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_path: String,
    filters: Vec<DialogFilter>,
) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&default_path);
    let default_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("annotations");

    let mut dialog = app.dialog().file().set_file_name(default_name);

    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(&f.name, &exts);
    }

    let result = dialog.blocking_save_file();

    Ok(result.and_then(|p| match p {
        FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
        _ => None,
    }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    // ── classify_ext ──────────────────────────────────────────────────────────
    //
    // Pure function: works on path strings, no filesystem I/O. Each case
    // documents the expected (is_audio, is_video) tuple for the given extension.

    #[test]
    fn classify_ext_audio_extensions() {
        // Every entry in AUDIO_EXTS should classify as audio.
        for ext in ["mp3", "flac", "wav", "ogg", "aac", "m4a"] {
            let p = PathBuf::from(format!("/tmp/song.{ext}"));
            assert_eq!(classify_ext(&p), (true, false), "ext .{ext} should be audio");
        }
    }

    #[test]
    fn classify_ext_video_extensions() {
        for ext in ["mp4", "mkv", "mov", "avi", "webm", "m4v"] {
            let p = PathBuf::from(format!("/tmp/clip.{ext}"));
            assert_eq!(classify_ext(&p), (false, true), "ext .{ext} should be video");
        }
    }

    #[test]
    fn classify_ext_unknown_extension() {
        assert_eq!(classify_ext(Path::new("/tmp/notes.xyz")), (false, false));
        assert_eq!(classify_ext(Path::new("/tmp/readme.txt")), (false, false));
    }

    #[test]
    fn classify_ext_no_extension() {
        assert_eq!(classify_ext(Path::new("/tmp/Makefile")), (false, false));
        assert_eq!(classify_ext(Path::new("/tmp/no_ext_here")), (false, false));
    }

    #[test]
    fn classify_ext_uppercase_is_case_insensitive() {
        // Implementation lowercases the extension before matching, so .MP3
        // should be treated identically to .mp3.
        assert_eq!(classify_ext(Path::new("/tmp/SONG.MP3")), (true, false));
        assert_eq!(classify_ext(Path::new("/tmp/CLIP.MP4")), (false, true));
        assert_eq!(classify_ext(Path::new("/tmp/CLIP.WeBm")), (false, true));
    }

    #[test]
    fn classify_ext_multiple_dots_uses_final_extension() {
        // Path::extension() returns only the component after the final dot.
        assert_eq!(classify_ext(Path::new("/tmp/foo.bar.mp3")), (true, false));
        assert_eq!(classify_ext(Path::new("/tmp/archive.tar.mp4")), (false, true));
        // Final extension is unknown even though an earlier component looks like audio.
        assert_eq!(classify_ext(Path::new("/tmp/foo.mp3.bak")), (false, false));
    }

    #[test]
    fn classify_ext_empty_path() {
        assert_eq!(classify_ext(Path::new("")), (false, false));
    }

    // ── assert_within_roots ───────────────────────────────────────────────────
    //
    // This function calls Path::canonicalize(), which is real filesystem I/O —
    // the paths must exist on disk. We use the OS temp dir to construct a small
    // sandbox structure and clean it up afterwards. Each test uses a unique
    // subdirectory so tests can run in parallel.

    /// Create a unique temp directory tree for a test. Returns the root path.
    /// The caller is responsible for cleanup via `cleanup_tmp`.
    fn make_tmp_root(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let root = std::env::temp_dir()
            .join(format!("seenote_fs_test_{tag}_{pid}_{nanos}"));
        std::fs::create_dir_all(&root).expect("create_dir_all tmp root");
        root
    }

    fn cleanup_tmp(p: &Path) {
        let _ = std::fs::remove_dir_all(p);
    }

    #[test]
    fn assert_within_roots_direct_child_ok() {
        let root = make_tmp_root("child");
        let child_dir = root.join("subdir");
        std::fs::create_dir_all(&child_dir).unwrap();
        let child_file = child_dir.join("file.txt");
        std::fs::write(&child_file, b"hi").unwrap();

        let roots = vec![root.to_string_lossy().to_string()];
        let res = assert_within_roots(&child_file, &roots);
        assert!(res.is_ok(), "direct child should be inside root: {res:?}");

        cleanup_tmp(&root);
    }

    #[test]
    fn assert_within_roots_path_is_root_ok() {
        // Documents current behavior: a path equal to the root is considered
        // "within" the root (Path::starts_with treats a path as starting with
        // itself).
        let root = make_tmp_root("isroot");
        let roots = vec![root.to_string_lossy().to_string()];
        let res = assert_within_roots(&root, &roots);
        assert!(res.is_ok(), "root itself should be accepted: {res:?}");
        cleanup_tmp(&root);
    }

    #[test]
    fn assert_within_roots_outside_all_roots_err() {
        let root = make_tmp_root("outside_a");
        let other = make_tmp_root("outside_b");
        let other_file = other.join("f.txt");
        std::fs::write(&other_file, b"x").unwrap();

        let roots = vec![root.to_string_lossy().to_string()];
        let res = assert_within_roots(&other_file, &roots);
        assert!(res.is_err(), "path outside all roots should err, got {res:?}");

        cleanup_tmp(&root);
        cleanup_tmp(&other);
    }

    #[test]
    fn assert_within_roots_empty_roots_allows_any_existing_path() {
        // Documented behavior in the doc-comment: empty roots = check skipped.
        let root = make_tmp_root("empty_roots");
        let file = root.join("f.txt");
        std::fs::write(&file, b"x").unwrap();

        let roots: Vec<String> = vec![];
        let res = assert_within_roots(&file, &roots);
        assert!(res.is_ok(), "empty roots should skip the check: {res:?}");

        cleanup_tmp(&root);
    }

    #[test]
    fn assert_within_roots_substring_prefix_not_treated_as_inside() {
        // SECURITY: if the implementation used naive string prefix matching, a
        // path like /tmp/<parent>/root_extra/x would appear to "start with"
        // /tmp/<parent>/root. Path::starts_with works on path components, so
        // this should correctly reject the substring-prefix case.
        let parent = make_tmp_root("prefix_parent");
        let root_a = parent.join("root");
        let root_a_lookalike = parent.join("root_extra");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_a_lookalike).unwrap();
        let evil_file = root_a_lookalike.join("evil.txt");
        std::fs::write(&evil_file, b"x").unwrap();

        let roots = vec![root_a.to_string_lossy().to_string()];
        let res = assert_within_roots(&evil_file, &roots);
        assert!(
            res.is_err(),
            "path in sibling dir with shared name prefix must be rejected, got {res:?}"
        );

        cleanup_tmp(&parent);
    }

    #[test]
    fn assert_within_roots_multiple_roots_path_in_one_ok() {
        let root_a = make_tmp_root("multi_a");
        let root_b = make_tmp_root("multi_b");
        let file_in_b = root_b.join("f.txt");
        std::fs::write(&file_in_b, b"x").unwrap();

        let roots = vec![
            root_a.to_string_lossy().to_string(),
            root_b.to_string_lossy().to_string(),
        ];
        let res = assert_within_roots(&file_in_b, &roots);
        assert!(res.is_ok(), "path in second root should be accepted: {res:?}");

        cleanup_tmp(&root_a);
        cleanup_tmp(&root_b);
    }

    #[test]
    fn assert_within_roots_nonexistent_path_errs() {
        // canonicalize() fails for nonexistent paths; this is current behavior.
        let root = make_tmp_root("nonexistent");
        let missing = root.join("does_not_exist.txt");

        let roots = vec![root.to_string_lossy().to_string()];
        let res = assert_within_roots(&missing, &roots);
        assert!(res.is_err(), "nonexistent path should err on canonicalize, got {res:?}");

        cleanup_tmp(&root);
    }
}
