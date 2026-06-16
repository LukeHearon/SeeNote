//! Annotation tools as on-disk folders under `{project_dir}/.seenote/annotation-tools/`.
//!
//! Each tool is a directory whose **name is the tool's label** — the exact
//! string written into annotation `.txt` files (`generateAudacityContent`).
//! Because annotation files link to tools purely by that label text, the
//! directory name IS the durable identity; there is no UUID.
//!
//! What lives in a tool directory:
//!   - `tool.json`        → `{ "color": "#hex" }` (the only structured attribute)
//!   - `description.txt`  → free-text memo, human-readable/editable (optional)
//!   - `examples/`        → example audio clips, auto-scanned, never listed anywhere
//!
//! Hotkeys are NOT stored here: a hotkey is a project-level binding (which of
//! the few `1`–`9` keys points at which label), so it lives in `settings.json`.
//!
//! These directories live inside the hidden `.seenote/` folder; users are not
//! expected to rename them by hand, so the app owns all renames (rename the
//! dir here, and the frontend's existing relabel flow rewrites matching text
//! in annotation files).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::commands::shared::{atomic_write, AUDIO_EXTS};

/// Contents of a tool's `tool.json`. Label is the directory name and the
/// description is `description.txt`, so only `color` lives here.
#[derive(Serialize, Deserialize, Default)]
struct ToolConfig {
    color: String,
}

/// A fully resolved tool returned to the frontend.
#[derive(Serialize)]
pub struct AnnotationTool {
    /// Directory name = label = the text persisted in annotation files.
    name: String,
    color: String,
    /// Contents of `description.txt`, or empty string if absent.
    description: String,
    /// Absolute paths to example audio clips, sorted. Safe to hand straight to
    /// `get_spectrogram_chunk` / the playback engine.
    example_files: Vec<String>,
}

fn tools_root(project_dir: &str) -> PathBuf {
    Path::new(project_dir)
        .join(".seenote")
        .join("annotation-tools")
}

/// Reject names that would escape the tools root or collide with hidden files.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("tool name cannot be empty".into());
    }
    if name.starts_with('.') {
        return Err("tool name cannot start with '.'".into());
    }
    if name.contains(|c| std::path::is_separator(c) || c == '/' || c == '\\') {
        return Err(format!("tool name '{name}' contains a path separator"));
    }
    Ok(())
}

fn read_color(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("tool.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<ToolConfig>(&s).ok())
        .map(|c| c.color)
        .unwrap_or_default()
}

fn read_description(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("description.txt")).unwrap_or_default()
}

fn is_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("._"))
        .unwrap_or(false)
}

fn is_audio_file(path: &Path) -> bool {
    !is_sidecar(path)
        && path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
}

/// Sorted absolute paths of audio files in a tool dir's `examples/` subfolder
/// (non-recursive). Missing subfolder → empty list.
fn scan_examples(tool_dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(tool_dir.join("examples")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_audio_file(&path) {
                out.push(path.to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    out
}

/// Write `color` to `tool.json` and `description` to `description.txt` (the
/// latter removed when empty, keeping the folder tidy).
fn write_attrs(dir: &Path, color: &str, description: &str) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&ToolConfig { color: color.to_string() })
        .map_err(|e| e.to_string())?;
    atomic_write(&dir.join("tool.json"), &json)?;

    let desc_path = dir.join("description.txt");
    if description.is_empty() {
        let _ = std::fs::remove_file(&desc_path);
        Ok(())
    } else {
        atomic_write(&desc_path, description)
    }
}

/// Scan `annotation-tools/`, returning one entry per subdirectory (sorted by
/// label). Missing root → empty list.
#[tauri::command]
pub async fn list_annotation_tools(project_dir: String) -> Result<Vec<AnnotationTool>, String> {
    let root = tools_root(&project_dir);
    let mut tools: Vec<AnnotationTool> = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(tools), // not yet created
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = match dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        tools.push(AnnotationTool {
            name,
            color: read_color(&dir),
            description: read_description(&dir),
            example_files: scan_examples(&dir),
        });
    }
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tools)
}

/// Example clips for a single tool, sorted.
#[tauri::command]
pub async fn list_tool_examples(
    project_dir: String,
    name: String,
) -> Result<Vec<String>, String> {
    validate_name(&name)?;
    Ok(scan_examples(&tools_root(&project_dir).join(&name)))
}

/// Whether a tool of this name exists. The marker is `tool.json`, not the bare
/// directory: a per-tool example import may create the folder before the
/// debounced frontend reconcile creates the tool itself, and that must not
/// trip the duplicate guard.
fn tool_exists(dir: &Path) -> bool {
    dir.join("tool.json").is_file()
}

/// Create a new tool directory with `tool.json` (+ `description.txt` if set).
/// Errors if a tool of that name already exists.
#[tauri::command]
pub async fn create_annotation_tool(
    project_dir: String,
    name: String,
    color: String,
    description: String,
) -> Result<(), String> {
    validate_name(&name)?;
    let dir = tools_root(&project_dir).join(&name);
    if tool_exists(&dir) {
        return Err(format!("a tool named '{name}' already exists"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_attrs(&dir, &color, &description)
}

/// Update an existing tool's color/description. Label changes go through
/// `rename_annotation_tool`.
#[tauri::command]
pub async fn update_annotation_tool(
    project_dir: String,
    name: String,
    color: String,
    description: String,
) -> Result<(), String> {
    validate_name(&name)?;
    let dir = tools_root(&project_dir).join(&name);
    if !dir.is_dir() {
        return Err(format!("no tool named '{name}'"));
    }
    write_attrs(&dir, &color, &description)
}

/// Rename a tool's directory. Caller is responsible for rewriting the matching
/// label text in existing annotation files (the frontend already does this for
/// in-app relabels). Errors if the target name is taken.
#[tauri::command]
pub async fn rename_annotation_tool(
    project_dir: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    validate_name(&old_name)?;
    validate_name(&new_name)?;
    if old_name == new_name {
        return Ok(());
    }
    let root = tools_root(&project_dir);
    let from = root.join(&old_name);
    let to = root.join(&new_name);
    if !from.is_dir() {
        return Err(format!("no tool named '{old_name}'"));
    }
    if to.exists() {
        return Err(format!("a tool named '{new_name}' already exists"));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Delete a tool directory and everything in it (example clips included).
/// Annotation files are untouched; rows that used this label fall back to the
/// Custom tool on next load, exactly as they would for any unmatched text.
#[tauri::command]
pub async fn delete_annotation_tool(project_dir: String, name: String) -> Result<(), String> {
    validate_name(&name)?;
    let dir = tools_root(&project_dir).join(&name);
    if !dir.is_dir() {
        return Ok(()); // already gone
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// Result of the import commands, reported back to the user.
#[derive(Serialize, Default)]
pub struct ImportExamplesSummary {
    /// Labels of tools that did not exist and were created by the import.
    pub tools_created: Vec<String>,
    pub files_copied: usize,
    /// Files skipped because the same filename already exists in the tool's
    /// `examples/` folder.
    pub files_skipped: usize,
}

/// Sorted subdirectories of `root` whose names are valid tool labels (hidden
/// and non-UTF8 names are skipped). Sorting keeps palette assignment
/// deterministic across runs.
fn labeled_subdirs(root: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let mut out = Vec::new();
    for dir in dirs {
        let name = match dir.file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.starts_with('.') => n.to_string(),
            _ => continue,
        };
        validate_name(&name)?;
        out.push((dir, name));
    }
    Ok(out)
}

/// Create `tool_dir` with a palette color if the tool doesn't exist yet,
/// recording the creation in `summary`. Existing tools are left untouched.
fn ensure_tool_dir(
    tool_dir: &Path,
    name: &str,
    palette: &[String],
    summary: &mut ImportExamplesSummary,
) -> Result<(), String> {
    if tool_exists(tool_dir) {
        return Ok(());
    }
    std::fs::create_dir_all(tool_dir).map_err(|e| e.to_string())?;
    let color = palette
        .get(summary.tools_created.len() % palette.len().max(1))
        .cloned()
        .unwrap_or_else(|| "#64748b".to_string());
    write_attrs(tool_dir, &color, "")?;
    summary.tools_created.push(name.to_string());
    Ok(())
}

/// Recursively collect the audio files under `dir` (sorted for deterministic
/// copy order). Missing `dir` yields an empty list.
fn collect_audio_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !is_sidecar(&path) {
                collect_audio_recursive(&path, out);
            } else if is_audio_file(&path) {
                out.push(path);
            }
        }
    }
}

/// Copy `files` flat into `tool_dir/examples/` (no subdirectories — the
/// example scan is non-recursive), skipping destination filenames that already
/// exist so imports are idempotent.
fn copy_audio_files(
    files: &[PathBuf],
    tool_dir: &Path,
    summary: &mut ImportExamplesSummary,
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let dst_dir = tool_dir.join("examples");
    std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    for file in files {
        let Some(file_name) = file.file_name() else { continue };
        let dst = dst_dir.join(file_name);
        if dst.exists() {
            summary.files_skipped += 1;
        } else {
            std::fs::copy(file, &dst).map_err(|e| e.to_string())?;
            summary.files_copied += 1;
        }
    }
    Ok(())
}

/// Copy all audio files under `src_dir` (recursively — nested folders are
/// flattened) into `tool_dir/examples/`. Missing `src_dir` is a no-op.
fn copy_examples_into(
    src_dir: &Path,
    tool_dir: &Path,
    summary: &mut ImportExamplesSummary,
) -> Result<(), String> {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_audio_recursive(src_dir, &mut files);
    files.sort();
    copy_audio_files(&files, tool_dir, summary)
}

/// Import a directory of **fully fleshed-out tool folders** — the same layout
/// as `.seenote/annotation-tools/` itself: one `{label}/` per tool, each
/// optionally holding `tool.json`, `description.txt`, and `examples/`.
///
/// New labels get their folder copied in (falling back to a cycled `palette`
/// color when `tool.json` is absent). Labels that already exist in the project
/// keep their color/description; only their example clips are merged. Sources
/// are copied, never moved, and existing destination filenames are skipped.
#[tauri::command]
pub async fn import_annotation_tools(
    project_dir: String,
    tools_dir: String,
    palette: Vec<String>,
) -> Result<ImportExamplesSummary, String> {
    let src_root = Path::new(&tools_dir);
    if !src_root.is_dir() {
        return Err(format!("tools directory not found: {tools_dir}"));
    }
    let root = tools_root(&project_dir);
    let mut summary = ImportExamplesSummary::default();

    for (src_dir, name) in labeled_subdirs(src_root)? {
        let tool_dir = root.join(&name);
        let is_new = !tool_exists(&tool_dir);
        ensure_tool_dir(&tool_dir, &name, &palette, &mut summary)?;
        if is_new {
            // Source attributes win for a brand-new tool; the palette color
            // written by ensure_tool_dir stays only when the source has none.
            let src_color = read_color(&src_dir);
            let src_desc = read_description(&src_dir);
            if !src_color.is_empty() || !src_desc.is_empty() {
                let color = if src_color.is_empty() { read_color(&tool_dir) } else { src_color };
                write_attrs(&tool_dir, &color, &src_desc)?;
            }
        }
        copy_examples_into(&src_dir.join("examples"), &tool_dir, &mut summary)?;
    }
    Ok(summary)
}

/// Import a directory of **plain example clips** — one `{label}/` folder per
/// tool, each holding audio files (nested subfolders are searched and
/// flattened; e.g. `bird_goose/clip1.mp3`).
/// Creates the appropriate tool dir for labels the project doesn't have yet
/// (colored by cycling `palette`, supplied by the frontend so color constants
/// stay single-sourced in TS) and copies the clips into `{tool}/examples/`.
/// Sources are copied, never moved; existing destination filenames are skipped.
#[tauri::command]
pub async fn import_tool_examples(
    project_dir: String,
    examples_dir: String,
    palette: Vec<String>,
) -> Result<ImportExamplesSummary, String> {
    let src_root = Path::new(&examples_dir);
    if !src_root.is_dir() {
        return Err(format!("examples directory not found: {examples_dir}"));
    }
    let root = tools_root(&project_dir);
    let mut summary = ImportExamplesSummary::default();

    for (src_dir, name) in labeled_subdirs(src_root)? {
        let tool_dir = root.join(&name);
        ensure_tool_dir(&tool_dir, &name, &palette, &mut summary)?;
        copy_examples_into(&src_dir, &tool_dir, &mut summary)?;
    }
    Ok(summary)
}

/// Import example clips into a **single tool** from an explicit selection:
/// each path may be an audio file or a directory (searched recursively).
/// Clips land flat in `{tool}/examples/`; existing filenames are skipped.
/// The tool folder is created bare if it doesn't exist yet (a brand-new
/// in-memory tool may not have been reconciled to disk when the user imports —
/// `create_annotation_tool` tolerates the pre-existing folder).
#[tauri::command]
pub async fn import_examples_to_tool(
    project_dir: String,
    name: String,
    paths: Vec<String>,
) -> Result<ImportExamplesSummary, String> {
    validate_name(&name)?;
    let tool_dir = tools_root(&project_dir).join(&name);
    let mut summary = ImportExamplesSummary::default();

    let mut files: Vec<PathBuf> = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        if path.is_dir() && !is_sidecar(path) {
            collect_audio_recursive(path, &mut files);
        } else if is_audio_file(path) {
            files.push(path.to_path_buf());
        }
    }
    files.sort();
    files.dedup();
    copy_audio_files(&files, &tool_dir, &mut summary)?;
    Ok(summary)
}
