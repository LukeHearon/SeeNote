use std::collections::HashSet;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

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
/// failing that, minus its final extension — used as the extraction folder
/// name when the archive has no single wrapping folder of its own.
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

/// Resolve both where extraction will land (`{dest_dir}/{folder_name}`) and
/// whether the archive already has a single top-level folder wrapping every
/// entry. When it does, entries already carry that folder in their own paths,
/// so extracting straight into `dest_dir` reproduces it; otherwise we extract
/// into a `{stem}` folder created for the occasion. Either way the result is
/// the same shape: `{dest_dir}/{name}/...`.
struct ExtractPlan {
    target: PathBuf,
    extract_root: PathBuf,
}

fn plan_extraction(archive_path: &Path, dest_dir: &Path) -> Result<ExtractPlan, String> {
    let top_level = list_top_level_names(archive_path)?;
    let has_wrapper = top_level.len() == 1;
    let folder_name = if has_wrapper {
        top_level.into_iter().next().unwrap()
    } else {
        stem_of(archive_path)
    };
    let target = dest_dir.join(&folder_name);
    // A lone wrapping folder is reproduced by extracting into dest_dir itself,
    // since each entry's own path already carries that folder name; anything
    // else needs a new folder created to collect the loose entries.
    let extract_root = if has_wrapper { dest_dir.to_path_buf() } else { target.clone() };
    Ok(ExtractPlan { target, extract_root })
}

/// Compute where extracting `archive_path` into `dest_dir` would land, without
/// extracting anything, so the frontend can show a "Will extract to: ..."
/// preview before the user commits. `extract_archive` reuses this exact logic
/// so the preview can never disagree with the result.
#[tauri::command]
pub async fn peek_archive_extract_path(archive_path: String, dest_dir: String) -> Result<String, String> {
    let plan = plan_extraction(&PathBuf::from(&archive_path), &PathBuf::from(&dest_dir))?;
    Ok(plan.target.to_string_lossy().to_string())
}

/// Extract `archive_path` (.zip, .tar, or .tar.gz/.tgz) into a new folder
/// inside `dest_dir`. Errors if that folder already exists — callers must have
/// the user pick a different destination rather than silently overwriting or
/// merging into existing files. Returns the final extracted directory path.
#[tauri::command]
pub async fn extract_archive(archive_path: String, dest_dir: String) -> Result<String, String> {
    let archive = PathBuf::from(&archive_path);
    let dest = PathBuf::from(&dest_dir);
    tauri::async_runtime::spawn_blocking(move || extract_archive_blocking(&archive, &dest))
        .await
        .map_err(|e| e.to_string())?
}

fn extract_archive_blocking(archive_path: &Path, dest_dir: &Path) -> Result<String, String> {
    let plan = plan_extraction(archive_path, dest_dir)?;
    if plan.target.exists() {
        return Err(format!("'{}' already exists", plan.target.display()));
    }
    std::fs::create_dir_all(&plan.extract_root).map_err(|e| e.to_string())?;

    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    if is_zip(archive_path) {
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        zip.extract(&plan.extract_root).map_err(|e| e.to_string())?;
    } else if is_tar_gz(archive_path) {
        let mut archive = tar::Archive::new(GzDecoder::new(BufReader::new(file)));
        archive.unpack(&plan.extract_root).map_err(|e| e.to_string())?;
    } else if is_tar(archive_path) {
        let mut archive = tar::Archive::new(BufReader::new(file));
        archive.unpack(&plan.extract_root).map_err(|e| e.to_string())?;
    } else {
        return Err(format!("unsupported archive type: {}", archive_path.display()));
    }

    if !plan.target.exists() {
        return Err(format!("extraction did not produce expected folder '{}'", plan.target.display()));
    }
    Ok(plan.target.to_string_lossy().to_string())
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
    fn wrapped_zip_extracts_into_its_own_top_level_folder() {
        let root = make_tmp_root("wrapped_zip");
        let archive = root.join("foo.zip");
        write_zip(&archive, &["foo/audio/a.wav", "foo/annotations/a.txt"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let result = extract_archive_blocking(&archive, &dest).unwrap();

        assert_eq!(result, dest.join("foo").to_string_lossy());
        assert!(dest.join("foo/audio/a.wav").exists());
        assert!(dest.join("foo/annotations/a.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn flat_zip_extracts_into_a_folder_named_after_the_archive() {
        let root = make_tmp_root("flat_zip");
        let archive = root.join("bar.zip");
        write_zip(&archive, &["audio/a.wav", "annotations/a.txt"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let result = extract_archive_blocking(&archive, &dest).unwrap();

        assert_eq!(result, dest.join("bar").to_string_lossy());
        assert!(dest.join("bar/audio/a.wav").exists());
        assert!(dest.join("bar/annotations/a.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn wrapped_tar_gz_extracts_into_its_own_top_level_folder() {
        let root = make_tmp_root("wrapped_targz");
        let archive = root.join("foo.tar.gz");
        write_tar_gz(&archive, &["foo/audio/a.wav", "foo/annotations/a.txt"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let result = extract_archive_blocking(&archive, &dest).unwrap();

        assert_eq!(result, dest.join("foo").to_string_lossy());
        assert!(dest.join("foo/audio/a.wav").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn peek_matches_actual_extraction_target() {
        let root = make_tmp_root("peek_matches");
        let archive = root.join("baz.zip");
        write_zip(&archive, &["baz/audio/a.wav"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let plan = plan_extraction(&archive, &dest).unwrap();
        let result = extract_archive_blocking(&archive, &dest).unwrap();

        assert_eq!(plan.target.to_string_lossy(), result);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extract_errors_when_target_already_exists() {
        let root = make_tmp_root("collision");
        let archive = root.join("foo.zip");
        write_zip(&archive, &["foo/audio/a.wav"]);
        let dest = root.join("dest");
        std::fs::create_dir_all(dest.join("foo")).unwrap();

        let result = extract_archive_blocking(&archive, &dest);

        assert!(result.is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
