use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::Path;
use tauri::Manager;

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "aac", "m4a"];
const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v"];

/// Wire-format record for an annotation tool, kept as `label_configs` in the
/// JSON for backward compatibility with existing project files.
#[derive(Serialize, Deserialize, Clone)]
pub struct AnnotationToolRecord {
    pub key: String,
    pub text: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub audio_directory: String,
    pub annotation_directory: String,
    pub output_format: String,
    pub created_at: String,
    pub last_opened: String,
    pub label_configs: Vec<AnnotationToolRecord>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub spectrogram_settings: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name_gradient_colors: Option<[String; 2]>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_rounding_decimals: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hide_annotated: Option<bool>,
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
pub async fn load_projects(projects_file: String) -> Result<Vec<ProjectRecord>, String> {
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
    projects: Vec<ProjectRecord>,
) -> Result<(), String> {
    let path = Path::new(&projects_file);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;

    // Atomic write: write to a sibling .tmp file then rename over the target
    // so that a crash mid-write never leaves projects.json truncated/corrupt.
    let tmp_path = {
        let mut t = path.to_path_buf();
        let mut name = t.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        t.set_file_name(name);
        t
    };

    std::fs::write(&tmp_path, &content).map_err(|e| {
        format!("failed to write temp file '{}': {}", tmp_path.display(), e)
    })?;

    if let Err(rename_err) = std::fs::rename(&tmp_path, path) {
        // Best-effort cleanup before returning the error.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to rename '{}' to '{}': {}", tmp_path.display(), path.display(), rename_err));
    }

    Ok(())
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
    collect_orphaned_annotations(ann_root, ann_root, audio_root, &mut orphans);
    Ok(orphans)
}

fn collect_orphaned_annotations(
    current: &Path,
    ann_root: &Path,
    audio_root: &Path,
    orphans: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_orphaned_annotations(&path, ann_root, audio_root, orphans);
        } else if path.extension().and_then(|e| e.to_str()) == Some("txt") {
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
        }
    }
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
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_ext_files(&path, ext, results);
        } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            results.push(path.to_string_lossy().to_string());
        }
    }
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
        if p.is_dir() {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path))
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

fn scan_annotation_files(
    dir: &Path,
    root: &Path,
    ext: &str,
    results: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_annotation_files(&path, root, ext, results);
        } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                let rel_no_ext = if let Some(s) = rel_str.strip_suffix(&format!(".{}", ext)) {
                    s.to_string()
                } else {
                    rel_str
                };
                results.push(rel_no_ext);
            }
        }
    }
}
