//! Streamed, cancellable, cached directory scans.
//!
//! One breadth-first walker serves every "list the files under this root"
//! need: the media tree, the annotation files, and the buzzdetect results. What
//! differs between them is only which names count, expressed as a [`ScanSpec`].
//! Each scan streams batches to the frontend as they're found, returns the full
//! sorted result, and refreshes an on-disk cache so the next open can show the
//! last known list immediately while the real scan reconciles it.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use super::filesystem::classify_ext;
use super::shared::atomic_write;

/// Files a scan matched (`files`) and, for a media scan, the other files it
/// walked past (`others`, shown as "unsupported" in the file tree). Also the
/// payload of each streamed batch (`camelCase` for the frontend).
#[derive(Serialize, Deserialize, Default)]
pub struct DirScan {
    pub files: Vec<String>,
    pub others: Vec<String>,
}

impl DirScan {
    fn len(&self) -> usize {
        self.files.len() + self.others.len()
    }
}

/// What a scan is looking for.
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScanSpec {
    /// Audio/video files go to `files`, every other file to `others`.
    Media,
    /// Files whose name ends with any of `suffixes` go to `files`; nothing else
    /// is collected. Used for annotation files (`.txt`) and buzzdetect results
    /// (`_buzzdetect.csv`, `_buzzpart.csv`).
    Suffixes { suffixes: Vec<String> },
}

enum Bucket {
    Files,
    Others,
    Skip,
}

impl ScanSpec {
    /// Part of the cache file's identity, so two kinds of scan over the same
    /// root never read each other's cache.
    fn tag(&self) -> String {
        match self {
            ScanSpec::Media => "media".to_string(),
            ScanSpec::Suffixes { suffixes } => format!("sfx:{}", suffixes.join(",")),
        }
    }

    fn classify(&self, path: &Path, name: &str) -> Bucket {
        match self {
            ScanSpec::Media => {
                let (is_audio, is_video) = classify_ext(path);
                if is_audio || is_video { Bucket::Files } else { Bucket::Others }
            }
            ScanSpec::Suffixes { suffixes } => {
                if suffixes.iter().any(|s| name.ends_with(s.as_str())) { Bucket::Files } else { Bucket::Skip }
            }
        }
    }
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/// Generation counter per (spec, root): starting a scan bumps its counter, and
/// any walk holding an older value bails out. Keeps a refresh from leaving a
/// stale walk hammering the drive next to the new one, without letting the
/// media, annotation and buzzdetect scans cancel each other.
fn generation_for(key: &str) -> Arc<AtomicU64> {
    static GENS: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
    GENS.get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(key.to_string())
        .or_default()
        .clone()
}

// ── Priority ─────────────────────────────────────────────────────────────────

type PriorityMap = Mutex<HashMap<String, (u64, Option<PathBuf>)>>;

fn priorities() -> &'static PriorityMap {
    static P: OnceLock<PriorityMap> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// Ask scans of `scan_root` to visit directories under `folder` first (the
/// folder the user is looking at). `None` clears the preference.
#[tauri::command]
pub fn set_scan_priority_folder(scan_root: String, folder: Option<String>) {
    let mut g = priorities().lock().unwrap();
    let entry = g.entry(scan_root).or_insert((0, None));
    entry.0 += 1;
    entry.1 = folder.map(PathBuf::from);
}

// ── Subtree results ──────────────────────────────────────────────────────────

/// A completed scan of one folder of a larger root, held until that root's full
/// scan runs. The full scan then skips the folder (it was just read) and folds
/// these results in, instead of walking it again.
struct SubtreeResult {
    tag: String,
    folder: PathBuf,
    scan: DirScan,
}

fn subtrees() -> &'static Mutex<Vec<SubtreeResult>> {
    static S: OnceLock<Mutex<Vec<SubtreeResult>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Remove and return the held subtree results for `tag` that lie under `root`.
/// Where one folder contains another, only the outer one is kept: its scan
/// already covered the inner.
fn take_subtrees(tag: &str, root: &Path) -> Vec<SubtreeResult> {
    let mut held = subtrees().lock().unwrap();
    let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *held)
        .into_iter()
        .partition(|r| r.tag == tag && r.folder.starts_with(root) && r.folder != root);
    *held = rest;
    let mut kept: Vec<SubtreeResult> = Vec::new();
    let mut mine = mine;
    mine.sort_by_key(|r| r.folder.components().count());
    for r in mine {
        if !kept.iter().any(|k| r.folder.starts_with(&k.folder)) {
            kept.push(r);
        }
    }
    kept
}

// ── Walk ─────────────────────────────────────────────────────────────────────

const BATCH_MAX_FILES: usize = 5000;
const BATCH_MAX_AGE: Duration = Duration::from_millis(300);

struct ScanState<'a> {
    generation: &'a AtomicU64,
    id: u64,
    spec: &'a ScanSpec,
    /// Folders already scanned as subtrees; the walk doesn't descend into them.
    skip: Vec<PathBuf>,
    all: DirScan,
    pending: DirScan,
    last_flush: Instant,
    on_batch: &'a Channel<DirScan>,
}

impl ScanState<'_> {
    fn superseded(&self) -> bool {
        self.generation.load(Ordering::Relaxed) != self.id
    }

    fn flush(&mut self) {
        let batch = std::mem::take(&mut self.pending);
        // Keep the authoritative copy here; the channel gets its own.
        self.all.files.extend(batch.files.iter().cloned());
        self.all.others.extend(batch.others.iter().cloned());
        let _ = self.on_batch.send(batch);
        self.last_flush = Instant::now();
    }
}

/// One breadth-first pass over `root`. Breadth-first so the top levels of every
/// folder arrive before any single folder is dug into; directories under the
/// priority folder jump the queue. An error on `root` itself is returned;
/// errors on nested directories are logged and skipped so one unreadable folder
/// doesn't sink the scan. Returns `Ok(false)` if the scan was superseded.
fn walk(root: &Path, root_key: &str, st: &mut ScanState) -> std::io::Result<bool> {
    let mut priority: VecDeque<PathBuf> = VecDeque::new();
    let mut normal: VecDeque<PathBuf> = VecDeque::new();
    normal.push_back(root.to_path_buf());
    let mut seen_version = u64::MAX;
    let mut prefix: Option<PathBuf> = None;
    let mut is_root = true;

    loop {
        if st.superseded() {
            return Ok(false);
        }
        {
            let g = priorities().lock().unwrap();
            let (version, folder) = g.get(root_key).cloned().unwrap_or((0, None));
            if version != seen_version {
                seen_version = version;
                prefix = folder;
                // Re-sort everything queued so far into the right lane.
                let queued: Vec<PathBuf> = priority.drain(..).chain(normal.drain(..)).collect();
                for d in queued {
                    if prefix.as_ref().is_some_and(|p| d.starts_with(p)) {
                        priority.push_back(d);
                    } else {
                        normal.push_back(d);
                    }
                }
            }
        }
        let Some(dir) = priority.pop_front().or_else(|| normal.pop_front()) else { break };
        let read_dir_iter = match std::fs::read_dir(&dir) {
            Ok(it) => it,
            Err(e) if is_root => return Err(e),
            Err(e) => {
                eprintln!("[SeeNote] scan: cannot read dir '{}': {}", dir.display(), e);
                continue;
            }
        };
        is_root = false;
        for entry_result in read_dir_iter {
            let entry = match entry_result {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[SeeNote] scan: error reading entry in '{}': {}", dir.display(), e);
                    continue;
                }
            };
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            // file_type() comes from the directory read itself (no extra stat
            // per entry, which is the dominant cost on external drives).
            // Symlinks need the followed metadata to know what they point at.
            let is_dir = match entry.file_type() {
                Ok(t) if t.is_symlink() => path.is_dir(),
                Ok(t) => t.is_dir(),
                Err(_) => path.is_dir(),
            };
            if is_dir {
                if st.skip.iter().any(|s| *s == path) {
                    continue;
                }
                if prefix.as_ref().is_some_and(|p| path.starts_with(p)) {
                    priority.push_back(path);
                } else {
                    normal.push_back(path);
                }
            } else {
                match st.spec.classify(&path, &name) {
                    Bucket::Files => st.pending.files.push(path.into_os_string().to_string_lossy().into_owned()),
                    Bucket::Others => st.pending.others.push(path.into_os_string().to_string_lossy().into_owned()),
                    Bucket::Skip => {}
                }
            }
        }
        // Flush between directories. A folder is read whole before the next, so
        // a huge flat folder yields one big batch — still one IPC message.
        if st.pending.len() >= BATCH_MAX_FILES
            || (st.pending.len() > 0 && st.last_flush.elapsed() >= BATCH_MAX_AGE)
        {
            st.flush();
        }
    }
    Ok(true)
}

// ── Cache ────────────────────────────────────────────────────────────────────

fn cache_path(app: &tauri::AppHandle, spec: &ScanSpec, root: &str) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    spec.tag().hash(&mut h);
    root.hash(&mut h);
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("dir-scan");
    Ok(dir.join(format!("{:016x}.json", h.finish())))
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    root: String,
    tag: String,
    #[serde(flatten)]
    scan: DirScan,
}

/// The lists from the last completed scan of `path` with this spec, or None.
/// May be stale (files added/removed since); the caller is expected to rescan.
#[tauri::command]
pub async fn read_scan_cache(app: tauri::AppHandle, path: String, spec: ScanSpec) -> Result<Option<DirScan>, String> {
    let cache_path = cache_path(&app, &spec, &path)?;
    let tag = spec.tag();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(raw) = std::fs::read(&cache_path) else { return Ok(None) };
        // A corrupt or old-format cache is just a miss.
        let Ok(cached) = serde_json::from_slice::<CacheFile>(&raw) else { return Ok(None) };
        Ok(if cached.root == path && cached.tag == tag { Some(cached.scan) } else { None })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete the cached lists for `path` (a hard refresh: don't trust them, and
/// don't leave them behind if the app quits before the rescan finishes).
#[tauri::command]
pub async fn clear_scan_cache(app: tauri::AppHandle, path: String, spec: ScanSpec) -> Result<(), String> {
    // A hard refresh must not resurface subtree results read before it.
    take_subtrees(&spec.tag(), Path::new(&path));
    let cache_path = cache_path(&app, &spec, &path)?;
    match std::fs::remove_file(&cache_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Walk `path` once, streaming batches over `on_batch` as files are found, then
/// return the complete sorted lists and refresh the on-disk cache.
///
/// `subtree` marks a scan of one folder of a larger root, run ahead of that
/// root's full scan so the folder's results show early. It isn't cached (a
/// partial list would read as the whole root's on the next open); it's held in
/// memory instead, and the root's next full scan skips the folder and folds
/// these results in rather than reading it twice.
///
/// Errs with "superseded" if a newer scan of the same root and spec started
/// first.
#[tauri::command]
pub async fn scan_tree(
    app: tauri::AppHandle,
    path: String,
    spec: ScanSpec,
    subtree: Option<bool>,
    on_batch: Channel<DirScan>,
) -> Result<DirScan, String> {
    let subtree = subtree.unwrap_or(false);
    let cache_path = cache_path(&app, &spec, &path)?;
    let generation = generation_for(&format!("{}\0{}", spec.tag(), path));
    let id = generation.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        // A full scan takes over any subtrees scanned ahead of it.
        let held = if subtree { Vec::new() } else { take_subtrees(&spec.tag(), Path::new(&path)) };
        let mut st = ScanState {
            generation: &generation,
            id,
            spec: &spec,
            skip: held.iter().map(|r| r.folder.clone()).collect(),
            all: DirScan::default(),
            pending: DirScan::default(),
            last_flush: Instant::now(),
            on_batch: &on_batch,
        };
        match walk(Path::new(&path), &path, &mut st) {
            Ok(true) => {}
            Ok(false) => return Err("superseded".to_string()),
            Err(e) => return Err(format!("cannot read '{}': {}", path, e)),
        }
        // Last partial batch: fold into `all` without another IPC send (the
        // final return value carries everything).
        let tail = std::mem::take(&mut st.pending);
        st.all.files.extend(tail.files);
        st.all.others.extend(tail.others);
        for r in held {
            st.all.files.extend(r.scan.files);
            st.all.others.extend(r.scan.others);
        }
        let mut result = st.all;
        // Cached keys: lowercasing once per path instead of once per comparison.
        result.files.sort_by_cached_key(|s| s.to_lowercase());
        result.others.sort_by_cached_key(|s| s.to_lowercase());

        if subtree {
            subtrees().lock().unwrap().push(SubtreeResult {
                tag: spec.tag(),
                folder: PathBuf::from(&path),
                scan: DirScan { files: result.files.clone(), others: result.others.clone() },
            });
            return Ok(result);
        }
        let cached = CacheFile { root: path, tag: spec.tag(), scan: result };
        let write = (|| -> Result<(), String> {
            if let Some(dir) = cache_path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let json = serde_json::to_string(&cached).map_err(|e| e.to_string())?;
            atomic_write(&cache_path, &json)
        })();
        if let Err(e) = write {
            eprintln!("[SeeNote] scan: could not write cache: {}", e);
        }
        Ok(cached.scan)
    })
    .await
    .map_err(|e| e.to_string())?
}
