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

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "aac", "m4a", "opus", "wma"];
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

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = std::path::Path::new(&path);
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

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
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .add_filter(
            "Audio/Video",
            &["mp3", "flac", "wav", "ogg", "aac", "m4a", "opus", "mp4", "mkv", "mov", "avi", "webm"],
        )
        .blocking_pick_file();

    Ok(result.and_then(|p| match p {
        FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
        _ => None,
    }))
}

#[tauri::command]
pub async fn open_directory_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app.dialog().file().blocking_pick_folder();

    Ok(result.and_then(|p| match p {
        FilePath::Path(pb) => Some(pb.to_string_lossy().to_string()),
        _ => None,
    }))
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
