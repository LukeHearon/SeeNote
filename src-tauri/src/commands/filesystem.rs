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
    // Ensure parent directories exist
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        std::fs::read_to_string(p)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
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

#[tauri::command]
pub async fn list_media_files_recursive(path: String) -> Result<Vec<String>, String> {
    let root = std::path::Path::new(&path);
    let mut files = Vec::new();
    collect_media_files(root, &mut files).map_err(|e| e.to_string())?;
    files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(files)
}

fn collect_media_files(dir: &std::path::Path, files: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_media_files(&path, files)?;
        } else {
            let (is_audio, is_video) = classify_ext(&path);
            if is_audio || is_video {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

/// Opens a dialog that allows selecting either a file or a folder.
/// Returns `{ path, is_dir }`.
#[tauri::command]
pub async fn open_file_or_folder_dialog(_app: tauri::AppHandle) -> Result<Option<OpenResult>, String> {
    // On macOS we can use NSOpenPanel with both canChooseFiles and canChooseDirectories.
    // The tauri dialog plugin doesn't expose this, so we use the file picker with a
    // workaround: first try picking a file. If the user cancels, we could offer a
    // directory picker, but for simplicity we configure the native panel directly.
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<Option<PathBuf>>();

        // NSOpenPanel must run on the main thread
        dispatch::Queue::main().exec_sync(move || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSOpenPanel;
            use objc2_app_kit::NSModalResponseOK;

            unsafe {
                let mtm = MainThreadMarker::new_unchecked();
                let panel = NSOpenPanel::openPanel(mtm);
                panel.setCanChooseFiles(true);
                panel.setCanChooseDirectories(true);
                panel.setAllowsMultipleSelection(false);

                let response = panel.runModal();
                if response == NSModalResponseOK {
                    let urls = panel.URLs();
                    if urls.count() > 0 {
                        let url = &urls.objectAtIndex(0);
                        if let Some(path) = url.path() {
                            let _ = tx.send(Some(PathBuf::from(path.to_string())));
                            return;
                        }
                    }
                }
                let _ = tx.send(None);
            }
        });

        let result = rx.recv().map_err(|e| e.to_string())?;

        match result {
            Some(pb) => {
                let is_dir = pb.is_dir();
                Ok(Some(OpenResult {
                    path: pb.to_string_lossy().to_string(),
                    is_dir,
                }))
            }
            None => Ok(None),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Fallback: file dialog only
        let result = app
            .dialog()
            .file()
            .add_filter(
                "Audio/Video",
                &["mp3", "flac", "wav", "ogg", "aac", "m4a", "opus", "mp4", "mkv", "mov", "avi", "webm"],
            )
            .blocking_pick_file();

        Ok(result.and_then(|p| match p {
            FilePath::Path(pb) => Some(OpenResult {
                path: pb.to_string_lossy().to_string(),
                is_dir: false,
            }),
            _ => None,
        }))
    }
}

#[tauri::command]
pub async fn remove_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct OpenResult {
    pub path: String,
    pub is_dir: bool,
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
