use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read};
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

/// What the archive's index says about its top level: the distinct first path
/// components (after dropping `.` and unsafe entries, so `./`-prefixed tars
/// read the same as unprefixed ones), and whether any entry sits below one.
struct TopLevel {
    names: HashSet<String>,
    nested: bool,
}

impl TopLevel {
    fn note(&mut self, path: &Path, is_dir: bool) {
        let Some(clean) = sanitize_relative(path) else { return };
        let mut comps = clean.components();
        let Some(first) = comps.next() else { return };
        self.names.insert(first.as_os_str().to_string_lossy().to_string());
        if is_dir || comps.next().is_some() {
            self.nested = true;
        }
    }

    /// The single folder every entry lives under, if there is exactly one.
    /// A lone top-level *file* is not a wrapper: stripping it would lose it.
    fn wrapper(&self) -> Option<&String> {
        if self.nested && self.names.len() == 1 { self.names.iter().next() } else { None }
    }
}

fn open_tar(archive_path: &Path) -> Result<tar::Archive<Box<dyn Read>>, String> {
    let file = BufReader::new(File::open(archive_path).map_err(|e| e.to_string())?);
    let reader: Box<dyn Read> = if is_tar_gz(archive_path) {
        Box::new(GzDecoder::new(file))
    } else if is_tar(archive_path) {
        Box::new(file)
    } else {
        return Err(format!("unsupported archive type: {}", archive_path.display()));
    };
    Ok(tar::Archive::new(reader))
}

/// Read the archive's index/headers (nothing is extracted).
fn list_top_level(archive_path: &Path) -> Result<TopLevel, String> {
    let mut top = TopLevel { names: HashSet::new(), nested: false };

    if is_zip(archive_path) {
        let file = File::open(archive_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| e.to_string())?;
            top.note(Path::new(entry.name()), entry.is_dir());
        }
    } else {
        let mut archive = open_tar(archive_path)?;
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            top.note(&path, entry.header().entry_type().is_dir());
        }
    }

    Ok(top)
}

/// Guess a project folder name from the archive: its single top-level
/// wrapping folder if it has one, else the archive's filename stem. Shown to
/// the user as an editable prefill — this is a starting point, not what
/// extraction is required to use.
#[tauri::command]
pub async fn guess_project_folder_name(archive_path: String) -> Result<String, String> {
    let archive = PathBuf::from(&archive_path);
    let top = list_top_level(&archive)?;
    Ok(top.wrapper().cloned().unwrap_or_else(|| stem_of(&archive)))
}

/// A folder name must be one plain path component: no separators, `..`, or
/// absolute/drive paths, so it can't escape `dest_dir`.
fn validate_folder_name(name: &str) -> Result<(), String> {
    let mut comps = Path::new(name).components();
    let ok = !name.contains(['/', '\\', '\0'])
        && matches!((comps.next(), comps.next()), (Some(Component::Normal(_)), None));
    if ok { Ok(()) } else { Err(format!("invalid folder name '{name}'")) }
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
    validate_folder_name(folder_name)?;
    let target = dest_dir.join(folder_name);
    if target.exists() {
        return Err(format!("'{}' already exists", target.display()));
    }
    let has_wrapper = list_top_level(archive_path)?.wrapper().is_some();
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    // create_dir (not _all) so a target that appeared since the check is an error
    // rather than being merged into — and then deleted on failure.
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;

    match extract_into(archive_path, &target, has_wrapper) {
        Ok(()) => Ok(target.to_string_lossy().to_string()),
        Err(e) => {
            // Don't leave a half-extracted project behind; the target didn't
            // exist before this call, so removing it is safe.
            let _ = std::fs::remove_dir_all(&target);
            Err(e)
        }
    }
}

fn extract_into(archive_path: &Path, target: &Path, has_wrapper: bool) -> Result<(), String> {
    if is_zip(archive_path) {
        let file = File::open(archive_path).map_err(|e| e.to_string())?;
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
    } else {
        let mut archive = open_tar(archive_path)?;
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            // Only plain files and directories. Symlinks/hardlinks could point
            // (or later entries could write through them) outside the target;
            // devices and the like have no place in a project.
            let kind = entry.header().entry_type();
            if !(kind.is_file() || kind.is_dir()) {
                continue;
            }
            let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
            let Some(relative) = relative_target(&entry_path, has_wrapper) else { continue };
            let out_path = target.join(&relative);
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            entry.unpack(&out_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::make_tmp_root;

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

        assert_eq!(list_top_level(&wrapped).unwrap().wrapper().map(String::as_str), Some("foo"));
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

    #[test]
    fn dot_slash_prefixed_tar_keeps_top_level_files() {
        let root = make_tmp_root("dotslash");
        let archive = root.join("p.tar.gz");
        write_tar_gz(&archive, &["./a.txt", "./b.txt", "./sub/c.txt"]);
        let dest = root.join("dest");

        extract_archive_blocking(&archive, &dest, "P").unwrap();

        assert!(dest.join("P/a.txt").exists());
        assert!(dest.join("P/b.txt").exists());
        assert!(dest.join("P/sub/c.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dot_slash_prefixed_wrapper_is_still_stripped() {
        let root = make_tmp_root("dotslash_wrap");
        let archive = root.join("p.tar.gz");
        write_tar_gz(&archive, &["./foo/a.txt", "./foo/b.txt"]);
        let dest = root.join("dest");

        extract_archive_blocking(&archive, &dest, "P").unwrap();

        assert!(dest.join("P/a.txt").exists());
        assert!(!dest.join("P/foo").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lone_top_level_file_is_not_treated_as_a_wrapper() {
        let root = make_tmp_root("lonefile");
        let archive = root.join("one.zip");
        write_zip(&archive, &["only.txt"]);
        let dest = root.join("dest");

        extract_archive_blocking(&archive, &dest, "One").unwrap();

        assert!(dest.join("One/only.txt").exists());
        assert!(list_top_level(&archive).unwrap().wrapper().is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn tar_symlink_entries_are_skipped() {
        let root = make_tmp_root("symlink");
        let archive = root.join("evil.tar");
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        {
            let mut builder = tar::Builder::new(File::create(&archive).unwrap());
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            link.set_cksum();
            builder.append_link(&mut link, "foo/escape", outside.to_str().unwrap()).unwrap();
            let data = b"pwned";
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, "foo/escape/x.txt", &data[..]).unwrap();
            let mut ok = tar::Header::new_gnu();
            ok.set_size(2);
            ok.set_mode(0o644);
            ok.set_cksum();
            builder.append_data(&mut ok, "foo/keep.txt", &b"hi"[..]).unwrap();
            builder.finish().unwrap();
        }
        let dest = root.join("dest");

        extract_archive_blocking(&archive, &dest, "P").unwrap();

        assert!(!outside.join("x.txt").exists(), "wrote through a symlink out of the target");
        assert!(dest.join("P/keep.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn folder_name_must_be_a_single_plain_component() {
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "/abs"] {
            assert!(validate_folder_name(bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(validate_folder_name("SeeNote Demo").is_ok());
        assert!(validate_folder_name("v1.2").is_ok());

        let root = make_tmp_root("badname");
        let archive = root.join("foo.zip");
        write_zip(&archive, &["foo/a.txt"]);
        let dest = root.join("dest");
        assert!(extract_archive_blocking(&archive, &dest, "../escape").is_err());
        assert!(!root.join("escape").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn failed_extraction_removes_the_partial_directory() {
        let root = make_tmp_root("partial");
        let archive = root.join("bad.tar");
        // A valid first entry, then truncation mid-second-entry.
        {
            let mut builder = tar::Builder::new(File::create(&archive).unwrap());
            let mut h = tar::Header::new_gnu();
            h.set_size(2);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, "a.txt", &b"hi"[..]).unwrap();
            let mut h = tar::Header::new_gnu();
            h.set_size(100_000);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, "b.txt", &vec![7u8; 100_000][..]).unwrap();
            builder.finish().unwrap();
        }
        let len = std::fs::metadata(&archive).unwrap().len();
        std::fs::OpenOptions::new().write(true).open(&archive).unwrap().set_len(len / 2).unwrap();
        let dest = root.join("dest");

        let result = extract_archive_blocking(&archive, &dest, "P");

        assert!(result.is_err());
        assert!(!dest.join("P").exists(), "partial extraction left behind");
        std::fs::remove_dir_all(&root).ok();
    }
}
