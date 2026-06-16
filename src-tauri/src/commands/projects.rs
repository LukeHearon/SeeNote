use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::Path;
use tauri::Manager;

use super::shared::{atomic_write, walk_files, AUDIO_EXTS, VIDEO_EXTS};

/// Slim registry entry stored in `{app_data}/.projects/projects.json`. Maps a
/// stable id to a project directory on this machine plus a `last_opened`
/// timestamp for sort order. Per-project settings live in
/// `{project_dir}/.seenote/settings.json`.
#[derive(Serialize, Deserialize, Clone)]
pub struct RegistryEntryRecord {
    pub id: String,
    pub project_dir: String,
    pub last_opened: String,
    /// Last-known project name (mirrors settings.json `name`). Optional so
    /// registries written by older builds still load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Last-known gradient colors (mirrors settings.json `nameGradientColors`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_gradient_colors: Option<[String; 2]>,
}

#[derive(Deserialize)]
pub struct CopySpec {
    pub src: String,
    pub dst: String,
}

#[derive(Serialize)]
pub struct CopyResult {
    pub copied: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_projects(projects_file: String) -> Result<Vec<RegistryEntryRecord>, String> {
    let path = Path::new(&projects_file);
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_projects(
    projects_file: String,
    projects: Vec<RegistryEntryRecord>,
) -> Result<(), String> {
    let path = Path::new(&projects_file);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    atomic_write(path, &content)
}

/// Read `{project_dir}/.seenote/settings.json` and return its parsed JSON.
/// Schema validation is performed on the TypeScript side.
#[tauri::command]
pub async fn read_project_settings(project_dir: String) -> Result<JsonValue, String> {
    let settings_path = Path::new(&project_dir).join(".seenote").join("settings.json");
    if !settings_path.exists() {
        return Err(format!("settings file not found: {}", settings_path.display()));
    }
    let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// Write `settings` to `{project_dir}/.seenote/settings.json`, creating the
/// `.seenote/` directory if missing. Uses the same atomic-rename pattern as
/// `save_projects`.
#[tauri::command]
pub async fn write_project_settings(
    project_dir: String,
    settings: JsonValue,
) -> Result<(), String> {
    let seenote_dir = Path::new(&project_dir).join(".seenote");
    std::fs::create_dir_all(&seenote_dir).map_err(|e| e.to_string())?;
    let settings_path = seenote_dir.join("settings.json");
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(&settings_path, &content)
}

#[tauri::command]
pub async fn project_dir_exists(project_dir: String) -> Result<bool, String> {
    Ok(Path::new(&project_dir).is_dir())
}

#[tauri::command]
pub async fn create_dir_all(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

fn has_media_file_with_stem(dir: &Path, stem: &str) -> bool {
    for ext in AUDIO_EXTS.iter().chain(VIDEO_EXTS.iter()) {
        let candidate = dir.join(format!("{}.{}", stem, ext));
        if candidate.exists() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn get_orphaned_annotations(
    annotation_dir: String,
    new_audio_dir: String,
) -> Result<Vec<String>, String> {
    let ann_root = Path::new(&annotation_dir);
    let audio_root = Path::new(&new_audio_dir);

    if !ann_root.exists() {
        return Ok(vec![]);
    }

    let mut orphans = vec![];
    collect_orphaned_annotations(ann_root, audio_root, &mut orphans);
    Ok(orphans)
}

fn collect_orphaned_annotations(ann_root: &Path, audio_root: &Path, orphans: &mut Vec<String>) {
    walk_files(ann_root, &mut |path| {
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            return;
        }
        // Derive relative path from annotation root
        if let Ok(rel) = path.strip_prefix(ann_root) {
            // Get the stem (remove .txt extension)
            if let Some(stem) = Path::new(rel).file_stem().and_then(|s| s.to_str()) {
                // Corresponding audio directory: audio_root / rel_parent
                let rel_parent = rel.parent().unwrap_or(Path::new(""));
                let audio_dir = audio_root.join(rel_parent);
                if !has_media_file_with_stem(&audio_dir, stem) {
                    orphans.push(path.to_string_lossy().to_string());
                }
            }
        }
    });
}

#[tauri::command]
pub async fn delete_files(paths: Vec<String>) -> Result<(), String> {
    let mut errors = vec![];
    for path_str in &paths {
        let path = Path::new(path_str);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(path) {
                errors.push(format!("{}: {}", path_str, e));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

#[tauri::command]
pub async fn list_txt_files_recursive(path: String, ext: Option<String>) -> Result<Vec<String>, String> {
    let root = Path::new(&path);
    if !root.exists() {
        return Ok(vec![]);
    }
    let extension = ext.as_deref().unwrap_or("txt").trim_start_matches('.');
    let mut results = vec![];
    collect_ext_files(root, extension, &mut results);
    results.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(results)
}

fn collect_ext_files(dir: &Path, ext: &str, results: &mut Vec<String>) {
    walk_files(dir, &mut |path| {
        if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            results.push(path.to_string_lossy().to_string());
        }
    });
}

#[tauri::command]
pub async fn copy_annotation_files(
    copies: Vec<CopySpec>,
    conflict_resolution: String,
) -> Result<CopyResult, String> {
    let mut copied = 0u32;
    let mut skipped = 0u32;
    let mut errors = vec![];

    for spec in &copies {
        let src = Path::new(&spec.src);
        let dst = Path::new(&spec.dst);

        if dst.exists() && conflict_resolution == "skip" {
            skipped += 1;
            continue;
        }

        if let Some(parent) = dst.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                errors.push(format!("{}: {}", spec.dst, e));
                continue;
            }
        }

        match std::fs::copy(src, dst) {
            Ok(_) => copied += 1,
            Err(e) => errors.push(format!("{}: {}", spec.dst, e)),
        }
    }

    Ok(CopyResult { copied, skipped, errors })
}

// ── Reveal in Finder / Explorer ──────────────────────────────────────────────

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    #[cfg(target_os = "macos")]
    {
        if p.is_dir() {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        let win_path = p.canonicalize()
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_string();
        // explorer.exe has non-standard argument parsing: Rust's Command wraps
        // args containing spaces in quotes, turning `/select,C:\my path\f.mp3`
        // into `"/select,C:\my path\f.mp3"` which explorer ignores (falls back
        // to Documents). raw_arg lets us embed the quotes inside /select, ourselves.
        use std::os::windows::process::CommandExt;
        if p.is_dir() {
            std::process::Command::new("explorer")
                .raw_arg(format!("\"{}\"", win_path))
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", win_path))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = p;
    }
    Ok(())
}

// ── Annotation file existence scanning ────────────────────────────────────────

#[tauri::command]
pub async fn list_annotation_files(
    annotation_dir: String,
    output_format: String,
) -> Result<Vec<String>, String> {
    let ext = match output_format.as_str() {
        "csv" => "csv",
        "json" => "json",
        _ => "txt",
    };
    let root = Path::new(&annotation_dir);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut results = vec![];
    scan_annotation_files(root, root, ext, &mut results);
    Ok(results)
}

fn scan_annotation_files(dir: &Path, root: &Path, ext: &str, results: &mut Vec<String>) {
    let dot_ext = format!(".{}", ext);
    walk_files(dir, &mut |path| {
        if path.extension().and_then(|e| e.to_str()) != Some(ext) {
            return;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let rel_no_ext = if let Some(s) = rel_str.strip_suffix(&dot_ext) {
                s.to_string()
            } else {
                rel_str
            };
            results.push(rel_no_ext);
        }
    });
}
