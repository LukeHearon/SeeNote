use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_audio: bool,
    pub is_video: bool,
}

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "aac", "m4a"];
const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v"];

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
    let tmp_path = {
        let mut t = target.to_path_buf();
        let mut name = t.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        t.set_file_name(name);
        t
    };

    std::fs::write(&tmp_path, &content).map_err(|e| {
        format!("failed to write temp file '{}': {}", tmp_path.display(), e)
    })?;

    if let Err(rename_err) = std::fs::rename(&tmp_path, target) {
        // Best-effort cleanup of the temp file before returning the error.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to rename '{}' to '{}': {}", tmp_path.display(), target.display(), rename_err));
    }

    Ok(())
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
