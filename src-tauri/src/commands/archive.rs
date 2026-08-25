use std::collections::HashSet;
use std::fs::File;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;

fn is_zip(path: &Path) -> bool {
    ext_name(path).ends_with(".zip")
}

fn is_tar_gz(path: &Path) -> bool {
    let name = ext_name(path);
    name.ends_with(".tar.gz") || name.ends_with(".tgz")
}

fn is_tar(path: &Path) -> bool {
    ext_name(path).ends_with(".tar")
}

fn ext_name(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase()
}

/// Archive filename minus a known compound suffix (`.tar.gz`/`.tgz`/`.tar`) or,
/// failing that, minus its final extension — the guessed project folder name
/// when the archive has no single wrapping folder of its own.
fn stem_of(archive_path: &Path) -> String {
    let file_name = archive_path.file_name().and_then(|n| n.to_str()).unwrap_or("archive");
    for suffix in [".tar.gz", ".tgz", ".tar", ".zip"] {
        if file_name.to_lowercase().ends_with(suffix) {
            let stripped = &file_name[..file_name.len() - suffix.len()];
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }
    }
    Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .to_string()
}

/// Top-level path component of every entry in the archive (deduplicated),
/// read from the archive's index/headers without extracting anything.
fn list_top_level_names(archive_path: &Path) -> Result<HashSet<String>, String> {
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let mut names = HashSet::new();

    if is_zip(archive_path) {
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if let Some(first) = entry.name().split('/').next() {
                if !first.is_empty() {
                    names.insert(first.to_string());
                }
            }
        }
    } else if is_tar_gz(archive_path) {
        let mut archive = tar::Archive::new(GzDecoder::new(BufReader::new(file)));
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            if let Some(first) = path.components().next() {
                names.insert(first.as_os_str().to_string_lossy().to_string());
            }
        }
    } else if is_tar(archive_path) {
        let mut archive = tar::Archive::new(BufReader::new(file));
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            if let Some(first) = path.components().next() {
                names.insert(first.as_os_str().to_string_lossy().to_string());
            }
        }
    } else {
        return Err(format!("unsupported archive type: {}", archive_path.display()));
    }

    Ok(names)
}

/// True when every entry in the archive shares one top-level folder — that
/// folder is stripped from each entry's path during extraction so the user's
/// chosen project folder name (not the archive's own folder name) becomes the
/// root instead.
fn has_single_wrapper(archive_path: &Path) -> Result<bool, String> {
    Ok(list_top_level_names(archive_path)?.len() == 1)
}

/// Guess a project folder name from the archive: its single top-level
/// wrapping folder if it has one, else the archive's filename stem. Shown to
/// the user as an editable prefill — this is a starting point, not what
/// extraction is required to use.
#[tauri::command]
pub async fn guess_project_folder_name(archive_path: String) -> Result<String, String> {
    let archive = PathBuf::from(&archive_path);
    let top_level = list_top_level_names(&archive)?;
    Ok(if top_level.len() == 1 {
        top_level.into_iter().next().unwrap()
    } else {
        stem_of(&archive)
    })
}

/// Reject any path containing `..` or an absolute-path component (root or
/// Windows drive prefix) — used on every entry we extract, from both zip and
/// tar, since neither this function's caller controls the archive's contents.
fn sanitize_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// Sanitize `path`, then drop its first component when `has_wrapper` is set
/// (the archive's own wrapping folder, which the caller supplies its own name
/// for instead). Returns `None` for an entry that sanitizes to empty — the
/// wrapper directory entry itself, or an unsafe path.
fn relative_target(path: &Path, has_wrapper: bool) -> Option<PathBuf> {
    let sanitized = sanitize_relative(path)?;
    let mut components: Vec<_> = sanitized.components().collect();
    if has_wrapper && !components.is_empty() {
        components.remove(0);
    }
    if components.is_empty() {
        return None;
    }
    Some(components.iter().collect())
}

/// Extract `archive_path` (.zip, .tar, or .tar.gz/.tgz) into `{dest_dir}/{folder_name}`,
/// stripping the archive's own top-level wrapping folder (if it has one) so
/// `folder_name` — not the archive's internal folder name — becomes the
/// project root. Errors if that folder already exists — callers must have the
/// user pick a different name/destination rather than silently overwriting or
/// merging into existing files. Returns the final extracted directory path.
#[tauri::command]
pub async fn extract_archive(archive_path: String, dest_dir: String, folder_name: String) -> Result<String, String> {
    let archive = PathBuf::from(&archive_path);
    let dest = PathBuf::from(&dest_dir);
    tauri::async_runtime::spawn_blocking(move || extract_archive_blocking(&archive, &dest, &folder_name))
        .await
        .map_err(|e| e.to_string())?
}

fn extract_archive_blocking(archive_path: &Path, dest_dir: &Path, folder_name: &str) -> Result<String, String> {
    let target = dest_dir.join(folder_name);
    if target.exists() {
        return Err(format!("'{}' already exists", target.display()));
    }
    let has_wrapper = has_single_wrapper(archive_path)?;
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    if is_zip(archive_path) {
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(relative) = entry
                .enclosed_name()
                .and_then(|p| relative_target(&p, has_wrapper))
            else {
                continue;
            };
            let out_path = target.join(&relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            }
        }
    } else if is_tar_gz(archive_path) || is_tar(archive_path) {
        let boxed_read: Box<dyn std::io::Read> = if is_tar_gz(archive_path) {
            Box::new(GzDecoder::new(BufReader::new(file)))
        } else {
            Box::new(BufReader::new(file))
        };
        let mut archive = tar::Archive::new(boxed_read);
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
            let Some(relative) = relative_target(&entry_path, has_wrapper) else { continue };
            let out_path = target.join(&relative);
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            entry.unpack(&out_path).map_err(|e| e.to_string())?;
        }
    } else {
        return Err(format!("unsupported archive type: {}", archive_path.display()));
    }

    Ok(target.to_string_lossy().to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_of_strips_compound_and_simple_extensions() {
        assert_eq!(stem_of(Path::new("foo.zip")), "foo");
        assert_eq!(stem_of(Path::new("foo.tar.gz")), "foo");
        assert_eq!(stem_of(Path::new("foo.tgz")), "foo");
        assert_eq!(stem_of(Path::new("foo.tar")), "foo");
        assert_eq!(stem_of(Path::new("FOO.TAR.GZ")), "FOO");
    }

    #[test]
    fn is_zip_tar_tar_gz_classify_by_extension() {
        assert!(is_zip(Path::new("a.zip")));
        assert!(!is_zip(Path::new("a.tar")));
        assert!(is_tar(Path::new("a.tar")));
        assert!(!is_tar(Path::new("a.tar.gz")));
        assert!(is_tar_gz(Path::new("a.tar.gz")));
        assert!(is_tar_gz(Path::new("a.tgz")));
    }

    #[test]
    fn relative_target_strips_wrapper_and_rejects_traversal() {
        assert_eq!(relative_target(Path::new("foo/audio/a.wav"), true), Some(PathBuf::from("audio/a.wav")));
        assert_eq!(relative_target(Path::new("foo"), true), None); // the wrapper dir entry itself
        assert_eq!(relative_target(Path::new("audio/a.wav"), false), Some(PathBuf::from("audio/a.wav")));
        assert_eq!(relative_target(Path::new("../../etc/passwd"), false), None);
        assert_eq!(relative_target(Path::new("/etc/passwd"), false), None);
    }

    // ── extraction, against real archives built on the fly ───────────────────

    fn make_tmp_root(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("seenote_archive_test_{tag}_{}_{nanos}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create_dir_all tmp root");
        root
    }

    /// Build a zip at `zip_path` containing `entries` (relative paths, each
    /// written as a small text file).
    fn write_zip(zip_path: &Path, entries: &[&str]) {
        let file = File::create(zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<()> = zip::write::FileOptions::default();
        for entry in entries {
            writer.start_file(*entry, options).unwrap();
            std::io::Write::write_all(&mut writer, b"data").unwrap();
        }
        writer.finish().unwrap();
    }

    /// Build a .tar.gz at `path` containing `entries` (relative paths, each a
    /// small text file).
    fn write_tar_gz(path: &Path, entries: &[&str]) {
        let file = File::create(path).unwrap();
        let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut builder = tar::Builder::new(enc);
        for entry in entries {
            let data = b"data";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, entry, &data[..]).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn wrapped_zip_extracts_under_the_chosen_folder_name() {
        let root = make_tmp_root("wrapped_zip");
        let archive = root.join("foo.zip");
        write_zip(&archive, &["foo/audio/a.wav", "foo/annotations/a.txt"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let result = extract_archive_blocking(&archive, &dest, "SeeNote Demo").unwrap();

        assert_eq!(result, dest.join("SeeNote Demo").to_string_lossy());
        assert!(dest.join("SeeNote Demo/audio/a.wav").exists());
        assert!(dest.join("SeeNote Demo/annotations/a.txt").exists());
        // The archive's own wrapper name must NOT appear in the output.
        assert!(!dest.join("SeeNote Demo/foo").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn flat_zip_extracts_under_the_chosen_folder_name() {
        let root = make_tmp_root("flat_zip");
        let archive = root.join("bar.zip");
        write_zip(&archive, &["audio/a.wav", "annotations/a.txt"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let result = extract_archive_blocking(&archive, &dest, "Custom Name").unwrap();

        assert_eq!(result, dest.join("Custom Name").to_string_lossy());
        assert!(dest.join("Custom Name/audio/a.wav").exists());
        assert!(dest.join("Custom Name/annotations/a.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn wrapped_tar_gz_extracts_under_the_chosen_folder_name() {
        let root = make_tmp_root("wrapped_targz");
        let archive = root.join("foo.tar.gz");
        write_tar_gz(&archive, &["foo/audio/a.wav", "foo/annotations/a.txt"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let result = extract_archive_blocking(&archive, &dest, "Renamed").unwrap();

        assert_eq!(result, dest.join("Renamed").to_string_lossy());
        assert!(dest.join("Renamed/audio/a.wav").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn guess_matches_wrapper_name_or_falls_back_to_stem() {
        let root = make_tmp_root("guess");
        let wrapped = root.join("foo.zip");
        write_zip(&wrapped, &["foo/audio/a.wav"]);
        let flat = root.join("bar.zip");
        write_zip(&flat, &["audio/a.wav", "annotations/a.txt"]);

        assert_eq!(list_top_level_names(&wrapped).unwrap().len(), 1);
        assert_eq!(stem_of(&flat), "bar");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extract_errors_when_target_already_exists() {
        let root = make_tmp_root("collision");
        let archive = root.join("foo.zip");
        write_zip(&archive, &["foo/audio/a.wav"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(dest.join("foo")).unwrap();

        let result = extract_archive_blocking(&archive, &dest, "foo");

        assert!(result.is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
