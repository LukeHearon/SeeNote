//! Annotation sync to a remote git repo, using embedded libgit2 (the `git2`
//! crate) so no system git is required on any machine.
//!
//! The single entry point is the `sync_project` command: it stages the
//! annotation files (only files matching [`shared::ANNOTATION_EXT`] inside the
//! annotation directory — never media, never local settings, never tools),
//! commits, fetches, merges, and pushes — all under one "Sync" button in the
//! UI. The load-bearing decisions:
//!
//! - **Only annotation data is tracked.** Annotation tools are deliberately
//!   NOT shared — each labeler maintains their own tools locally. The whole
//!   `.seenote/` directory (machine paths, UI state, the auth token, and the
//!   tool folders) stays local, so config can never produce a git conflict and
//!   the token never reaches the remote.
//! - **Annotation files get a semantic 3-way *set-merge*** ([`set_merge`]):
//!   each file is treated as an unordered set of `(start, end, label)` records,
//!   not an ordered document. Two people adding annotations to the same
//!   recording always auto-merge to the union; a deliberate delete is honored;
//!   nothing is silently dropped. This is the ONLY merge logic with a UI cost
//!   (there is none — it never prompts). Any other conflicting file auto-
//!   resolves favor-incoming.
//! - **Commit author is a name the user typed once** — git author is just a
//!   string, so per-user attribution works with one shared GitHub token.
//!
//! The annotation file format is mirrored from the TS side
//! (`utils/helpers.ts` `generateAudacityContent` / `parseAudacityContent`):
//! tab-delimited `start \t end \t label`, one record per line. The set-merge
//! here treats whole lines as opaque record identities, so it does not need to
//! understand the columns beyond the leading start time used for ordering. The
//! tracked extension comes from [`shared::ANNOTATION_EXT`].

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use git2::{
    AnnotatedCommit, Cred, FetchOptions, MergeOptions, PushOptions, RemoteCallbacks,
    Repository, Signature,
};
use serde::Serialize;

use super::shared::ANNOTATION_EXT;

/// Branch SeeNote syncs on. Single shared branch keeps the model simple; the
/// lab works off one line of history.
/// Branch used only when SeeNote freshly inits a repo (unborn/detached HEAD).
/// Otherwise the repo's current branch is used.
const DEFAULT_BRANCH: &str = "main";
const REMOTE_NAME: &str = "origin";

/// Prefix on error messages caused by GitHub rejecting the access token (401).
/// The frontend keys on this to show a token-specific message rather than a
/// generic "sync failed". We can't distinguish expired from revoked at the git
/// protocol level — both are a 401 — so the message covers both.
const AUTH_ERROR_PREFIX: &str = "AUTH_FAILED:";

/// What changed as a result of a sync, for the non-blocking post-sync summary.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// True if remote history was pulled in (something to merge existed).
    pub pulled: bool,
    /// True if local changes were committed and pushed.
    pub pushed: bool,
    /// Annotation records that arrived from teammates (present after merge but
    /// not in our pre-merge state).
    pub annotations_added: usize,
    /// Annotation records removed by teammates' deletions.
    pub annotations_removed: usize,
    /// Repo-relative paths of annotation files whose content changed by pulling.
    pub recordings_changed: Vec<String>,
    /// Annotation records added in our push (in new HEAD but not in old remote).
    pub annotations_uploaded: usize,
    /// Annotation records removed in our push (in old remote but not in new HEAD).
    pub annotations_removed_on_push: usize,
    /// Number of recording files with annotation changes uploaded.
    pub idents_uploaded: usize,
    /// Human-readable note for the UI (e.g. "Already up to date").
    pub message: String,
}

/// Local-only sync state (no network). Used to drive the status-dot indicators.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// True if annotation files on disk differ from HEAD, or HEAD is ahead of the
    /// remote tracking branch (uncommitted or unpushed changes).
    pub has_local_changes: bool,
    /// True if the remote tracking branch is ahead of HEAD (based on the most
    /// recently fetched remote state — no network call is made here).
    pub has_remote_changes: bool,
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_project(
    project_dir: String,
    annotation_dir: String,
    remote_url: String,
    token: String,
    author_name: String,
) -> Result<SyncSummary, String> {
    // Heavy/blocking libgit2 work off the async runtime's cooperative threads.
    tauri::async_runtime::spawn_blocking(move || {
        sync_blocking(&project_dir, &annotation_dir, &remote_url, &token, &author_name)
    })
    .await
    .map_err(|e| format!("sync task panicked: {e}"))?
}

/// Return local-only sync status (no network). Checks uncommitted annotation
/// changes and whether HEAD is ahead of the remote tracking branch.
#[tauri::command]
pub async fn get_local_sync_status(
    project_dir: String,
    annotation_dir: String,
) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        local_sync_status_blocking(&project_dir, &annotation_dir)
    })
    .await
    .map_err(|e| format!("status check panicked: {e}"))?
}

/// Fetch the remote branch and return whether remote is ahead of HEAD.
/// This makes a network call; call it on a slow heartbeat only.
#[tauri::command]
pub async fn fetch_remote_status(
    project_dir: String,
    remote_url: String,
    token: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_remote_status_blocking(&project_dir, &remote_url, &token)
    })
    .await
    .map_err(|e| format!("fetch status check panicked: {e}"))?
}

fn sync_blocking(
    project_dir: &str,
    annotation_dir: &str,
    remote_url: &str,
    token: &str,
    author_name: &str,
) -> Result<SyncSummary, String> {
    let project_path = Path::new(project_dir);
    let ann_path = Path::new(annotation_dir);

    // Precondition: the annotation directory must live inside the project dir,
    // because the project dir is the git repo root. (Mirrors the TS guard
    // isInsideProjectDir.)
    let ann_rel = ann_path
        .strip_prefix(project_path)
        .map_err(|_| {
            "Annotation directory must be inside the project directory to sync. \
             Move it under the project folder, or change the project's annotation \
             directory setting."
                .to_string()
        })?
        .to_path_buf();

    let author = match author_name.trim() {
        "" => "SeeNote",
        name => name,
    };
    if remote_url.trim().is_empty() {
        return Err("Set a remote repository URL in project settings before syncing.".into());
    }

    let repo = open_or_init(project_path, remote_url)?;
    write_gitignore(project_path, &ann_rel)?;

    let sig = Signature::now(author, &author_email(author)).map_err(gerr)?;

    // Sync on the repo's CURRENT branch, so dropping SeeNote into an existing
    // repo never switches branches or forks a stray `main`. Only a freshly
    // init'd repo (unborn/detached HEAD) falls back to `main`.
    let branch = current_branch(&repo);
    ensure_on_branch(&repo, &branch)?;

    // 1. Stage the curated set and commit any local changes.
    let pushed_local = stage_and_commit(&repo, project_path, &ann_rel, &sig)?;

    // 2. Fetch remote.
    fetch(&repo, &branch, token)?;

    // Snapshot the remote's actual state *after* fetch — this is what the remote
    // had right before our push, so the push delta (new HEAD minus this) is
    // exactly our net contribution. Capturing it pre-fetch would be wrong: on a
    // first sync the local tracking ref doesn't exist yet (None baseline), which
    // would count everything we just pulled as "uploaded"; and a stale pre-fetch
    // ref would miscredit a teammate's pushes as ours.
    let remote_tree_before_push = repo
        .refname_to_id(&format!("refs/remotes/{REMOTE_NAME}/{branch}"))
        .ok()
        .and_then(|oid| repo.find_commit(oid).ok())
        .and_then(|c| c.tree().ok());

    // 3. Merge remote tracking branch into local (set-merge for annotations).
    let mut summary = merge_remote(&repo, &branch, &ann_rel, &sig)?;

    // 4. Push.
    let pushed = push(&repo, &branch, token)?;
    summary.pushed = pushed || pushed_local;

    // Compute push stats: what we uploaded that wasn't on remote before sync.
    if summary.pushed {
        let new_head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        if let Some(new_tree) = new_head_tree {
            let (files, added, removed) =
                tree_annotation_delta(&repo, remote_tree_before_push.as_ref(), &new_tree)?;
            summary.idents_uploaded = files;
            summary.annotations_uploaded = added;
            summary.annotations_removed_on_push = removed;
        }
    }

    if summary.message.is_empty() {
        summary.message = if summary.pulled || summary.pushed {
            "Sync complete.".into()
        } else {
            "Already up to date.".into()
        };
    }
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Repo setup
// ---------------------------------------------------------------------------

/// The branch SeeNote syncs on: the repo's current branch when HEAD is born on
/// one, else [`DEFAULT_BRANCH`] (a freshly init'd repo with an unborn HEAD, or a
/// detached HEAD). Using the current branch means dropping SeeNote into an
/// existing repo never switches branches or forks a stray `main`.
fn current_branch(repo: &Repository) -> String {
    if let Ok(head) = repo.head() {
        if head.is_branch() {
            if let Some(name) = head.shorthand() {
                return name.to_string();
            }
        }
    }
    DEFAULT_BRANCH.to_string()
}

/// Point HEAD at `branch` if it isn't already. For an existing repo this is a
/// no-op (`branch` is the current branch by construction); it only acts for a
/// freshly init'd repo whose unborn HEAD defaults to `master`, repointing it so
/// the first commit lands on `branch`. Never switches an existing born branch.
fn ensure_on_branch(repo: &Repository, branch: &str) -> Result<(), String> {
    let already = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s == branch))
        .unwrap_or(false);
    if !already {
        repo.set_head(&format!("refs/heads/{branch}")).map_err(gerr)?;
    }
    Ok(())
}

fn open_or_init(project_path: &Path, remote_url: &str) -> Result<Repository, String> {
    let repo = match Repository::open(project_path) {
        Ok(r) => r,
        Err(_) => Repository::init(project_path).map_err(gerr)?,
    };
    // Ensure origin points at the configured URL (idempotent; updates on change).
    match repo.find_remote(REMOTE_NAME) {
        Ok(existing) => {
            if existing.url() != Some(remote_url) {
                repo.remote_set_url(REMOTE_NAME, remote_url).map_err(gerr)?;
            }
        }
        Err(_) => {
            repo.remote(REMOTE_NAME, remote_url).map_err(gerr)?;
        }
    }
    Ok(repo)
}

/// Write gitignores SCOPED to the directories SeeNote owns, so SeeNote can be
/// dropped into an existing repo (full of source code etc.) without disturbing
/// how that repo tracks everything else. We never write a repo-root `.gitignore`.
///
/// Two files:
/// - `<annotationDir>/.gitignore` — within the annotation directory only, track
///   just annotation files ([`ANNOTATION_EXT`]); ignore anything else dropped
///   in there. This is also committed (shared).
/// - `.seenote/.gitignore` — ignore the entire `.seenote/` directory, so the
///   host repo's `git add .` never picks up SeeNote's local state (machine
///   paths, UI, the token, tools). Not committed (it's inside the ignored dir).
fn write_gitignore(project_path: &Path, ann_rel: &Path) -> Result<(), String> {
    let ann_rel_posix = ann_rel.to_string_lossy().replace('\\', "/");
    // Guard the pathological case where the annotation dir IS the repo root —
    // a `*` ignore there would smother the whole repo. Skip it; explicit staging
    // still keeps the commit annotation-only.
    if !ann_rel_posix.is_empty() && ann_rel_posix != "." {
        let ann_dir = project_path.join(ann_rel);
        std::fs::create_dir_all(&ann_dir)
            .map_err(|e| format!("failed to create annotation dir: {e}"))?;
        let content = format!(
            "# Generated by SeeNote. Within this annotation directory, track only\n\
             # annotation files (*.{ext}); ignore anything else.\n\
             *\n\
             !*/\n\
             !*.{ext}\n\
             !.gitignore\n",
            ext = ANNOTATION_EXT,
        );
        std::fs::write(ann_dir.join(".gitignore"), content)
            .map_err(|e| format!("failed to write annotation .gitignore: {e}"))?;
    }

    let seenote_dir = project_path.join(".seenote");
    if seenote_dir.is_dir() {
        std::fs::write(
            seenote_dir.join(".gitignore"),
            "# SeeNote local state — never commit (machine paths, UI, token, tools).\n*\n",
        )
        .map_err(|e| format!("failed to write .seenote/.gitignore: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Stage + commit
// ---------------------------------------------------------------------------

/// Stage the curated set explicitly (never `git add .`) and commit if the index
/// differs from HEAD. Returns true if a commit was created.
fn stage_and_commit(
    repo: &Repository,
    project_path: &Path,
    ann_rel: &Path,
    sig: &Signature,
) -> Result<bool, String> {
    let mut index = repo.index().map_err(gerr)?;

    // (a) Annotation files under the annotation directory. Annotation tools are
    //     deliberately NOT synced — each labeler maintains their own tools.
    let ann_abs = project_path.join(ann_rel);
    let mut staged_paths: Vec<PathBuf> = Vec::new();
    collect_annotation_files(&ann_abs, &mut staged_paths);

    // (b) The annotation directory's own .gitignore (shared). The .seenote
    //     gitignore is intentionally not staged — it lives in the ignored dir.
    staged_paths.push(project_path.join(ann_rel).join(".gitignore"));

    for abs in &staged_paths {
        if let Ok(rel) = abs.strip_prefix(project_path) {
            // add_path also picks up modifications; removed files handled below.
            index.add_path(rel).map_err(gerr)?;
        }
    }
    // Stage deletions of previously-tracked annotation files that no longer
    // exist on disk, so a deleted recording's labels propagate.
    stage_deletions(repo, &mut index, project_path, ann_rel)?;

    // Untrack anything previously committed under .seenote/ — older versions of
    // SeeNote synced tool definitions there; tools are no longer shared. The
    // files stay on disk (now gitignored) but drop out of the next commit.
    let seenote_tracked: Vec<PathBuf> = (0..index.len())
        .filter_map(|i| index.get(i))
        .map(|e| String::from_utf8_lossy(&e.path).into_owned())
        .filter(|p| p.starts_with(".seenote/"))
        .map(PathBuf::from)
        .collect();
    for p in seenote_tracked {
        let _ = index.remove_path(&p);
    }

    index.write().map_err(gerr)?;
    let tree_oid = index.write_tree().map_err(gerr)?;
    let tree = repo.find_tree(tree_oid).map_err(gerr)?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    // Skip empty commits.
    if let Some(p) = &parent {
        if p.tree_id() == tree_oid {
            return Ok(false);
        }
    } else if tree.is_empty() {
        return Ok(false);
    }

    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        sig,
        sig,
        "Update annotations",
        &tree,
        &parents,
    )
    .map_err(gerr)?;
    Ok(true)
}

/// Mark for removal any currently-tracked annotation file that no longer exists
/// in the working tree (an intentional deletion to propagate).
fn stage_deletions(
    repo: &Repository,
    index: &mut git2::Index,
    project_path: &Path,
    ann_rel: &Path,
) -> Result<(), String> {
    let head_tree = match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(t) => t,
        None => return Ok(()), // no commits yet
    };
    let ann_rel_posix = ann_rel.to_string_lossy().replace('\\', "/");
    let mut to_remove: Vec<PathBuf> = Vec::new();
    head_tree
        .walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() != Some(git2::ObjectType::Blob) {
                return git2::TreeWalkResult::Ok;
            }
            let name = match entry.name() {
                Some(n) => n,
                None => return git2::TreeWalkResult::Ok,
            };
            let rel = format!("{dir}{name}");
            let is_annotation = rel.starts_with(&ann_rel_posix)
                && rel.ends_with(&format!(".{ANNOTATION_EXT}"));
            if is_annotation && !project_path.join(&rel).exists() {
                to_remove.push(PathBuf::from(&rel));
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(gerr)?;
    for rel in to_remove {
        let _ = index.remove_path(&rel);
    }
    Ok(())
}

fn collect_annotation_files(dir: &Path, out: &mut Vec<PathBuf>) {
    super::shared::walk_files(dir, &mut |p| {
        if p.extension().and_then(|e| e.to_str()) == Some(ANNOTATION_EXT) {
            out.push(p.to_path_buf());
        }
    });
}

// ---------------------------------------------------------------------------
// Fetch / merge / push
// ---------------------------------------------------------------------------

fn credentials_callbacks(token: &str) -> RemoteCallbacks<'_> {
    let mut cb = RemoteCallbacks::new();
    let mut attempts = 0u32;
    cb.credentials(move |_url, _username, _allowed| {
        attempts += 1;
        // libgit2 only re-requests credentials after the server rejected the
        // previous set — so a second call means the token is bad (expired or
        // revoked). Abort with a recognizable message rather than retrying in a
        // loop; `is_auth_error` keys on the 401/authentication wording.
        if attempts > 1 {
            return Err(git2::Error::from_str(
                "token rejected: 401 authentication failed",
            ));
        }
        // GitHub over HTTPS accepts a PAT with username "x-access-token"
        // (works for fine-grained PATs and app installation tokens alike).
        Cred::userpass_plaintext("x-access-token", token)
    });
    cb
}

/// True if a remote error stems from GitHub rejecting the token (401), as
/// opposed to a network error, bad URL, missing repo, etc.
fn is_auth_error(e: &git2::Error) -> bool {
    if e.code() == git2::ErrorCode::Auth {
        return true;
    }
    let m = e.message().to_ascii_lowercase();
    m.contains("401")
        || m.contains("authentication")
        || m.contains("authenticate")
        || m.contains("token rejected")
}

/// Map a remote (fetch/push) error to a user-facing message, calling out a
/// rejected token specifically (prefixed with [`AUTH_ERROR_PREFIX`]) so the
/// frontend can react to it distinctly. `action` reads as "… to {action}".
fn remote_err(action: &str, e: &git2::Error) -> String {
    if is_auth_error(e) {
        format!(
            "{AUTH_ERROR_PREFIX} GitHub rejected your access token while trying to {action}. \
             It has most likely expired or been revoked. Generate a new token and update it \
             under Project Settings → Sync."
        )
    } else {
        format!(
            "Could not {action}: {} (check the repository URL and your connection).",
            e.message()
        )
    }
}

fn fetch(repo: &Repository, branch: &str, token: &str) -> Result<(), String> {
    let mut remote = repo.find_remote(REMOTE_NAME).map_err(gerr)?;
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(credentials_callbacks(token));
    // Fetch the sync branch; ignore "couldn't find remote ref" on an empty
    // remote (first ever push).
    let refspec = format!("refs/heads/{branch}:refs/remotes/{REMOTE_NAME}/{branch}");
    match remote.fetch(&[&refspec], Some(&mut fo), None) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == git2::ErrorCode::NotFound && !is_auth_error(&e) => Ok(()),
        Err(e) => Err(remote_err("reach the remote", &e)),
    }
}

fn remote_tracking_commit<'a>(repo: &'a Repository, branch: &str) -> Option<AnnotatedCommit<'a>> {
    let oid = repo
        .refname_to_id(&format!("refs/remotes/{REMOTE_NAME}/{branch}"))
        .ok()?;
    repo.find_annotated_commit(oid).ok()
}

/// Update the working tree to HEAD, but ONLY under the annotation directory, so
/// a pull never touches the host repo's source files (matching the "SeeNote only
/// updates the annotations dir" contract). Falls back to a full checkout when the
/// annotation dir is the repo root.
fn checkout_annotations(repo: &Repository, ann_rel: &Path) -> Result<(), String> {
    let rel = ann_rel.to_string_lossy().replace('\\', "/");
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force();
    if !rel.is_empty() && rel != "." {
        cb.path(&rel);
    }
    repo.checkout_head(Some(&mut cb)).map_err(gerr)
}

/// Merge the remote tracking branch into HEAD, resolving conflicts with the
/// set-merge for annotation files and favor-incoming for everything else.
fn merge_remote(
    repo: &Repository,
    branch: &str,
    ann_rel: &Path,
    sig: &Signature,
) -> Result<SyncSummary, String> {
    let mut summary = SyncSummary::default();

    let their = match remote_tracking_commit(repo, branch) {
        Some(c) => c,
        None => return Ok(summary), // empty remote, nothing to merge
    };

    let our_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    // Local has no commits yet but remote has content: check out theirs.
    let our_commit = match our_commit {
        Some(c) => c,
        None => {
            let their_commit = repo.find_commit(their.id()).map_err(gerr)?;
            repo.branch(branch, &their_commit, true).map_err(gerr)?;
            repo.set_head(&format!("refs/heads/{branch}")).map_err(gerr)?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .map_err(gerr)?;
            summary.pulled = true;
            return Ok(summary);
        }
    };

    let (analysis, _) = repo.merge_analysis(&[&their]).map_err(gerr)?;
    if analysis.is_up_to_date() {
        return Ok(summary);
    }

    let their_commit = repo.find_commit(their.id()).map_err(gerr)?;
    let our_tree = our_commit.tree().map_err(gerr)?;
    let their_tree = their_commit.tree().map_err(gerr)?;

    if analysis.is_fast_forward() {
        // No local commits ahead: just move HEAD and check out, then summarize
        // the incoming annotation delta.
        summary_diff(repo, &our_tree, &their_tree, &mut summary)?;
        let refname = format!("refs/heads/{branch}");
        let mut reference = repo
            .find_reference(&refname)
            .or_else(|_| repo.reference(&refname, their.id(), true, "fast-forward"))
            .map_err(gerr)?;
        reference.set_target(their.id(), "fast-forward").map_err(gerr)?;
        repo.set_head(&refname).map_err(gerr)?;
        checkout_annotations(repo, ann_rel)?;
        summary.pulled = true;
        return Ok(summary);
    }

    // True three-way merge. When the histories are unrelated (no merge base —
    // e.g. the first sync where the local repo was init'd separately from a
    // remote that already has annotations), use an EMPTY tree as the base. That
    // makes every line on both sides read as an add, so every shared annotation
    // file becomes an add/add conflict that set_merge resolves to the union —
    // exactly what we want. (Using our_tree as the base would instead make
    // theirs win wholesale and silently drop our-only lines.)
    let empty_tree = {
        let oid = repo.treebuilder(None).map_err(gerr)?.write().map_err(gerr)?;
        repo.find_tree(oid).map_err(gerr)?
    };
    let ancestor_tree = match repo.merge_base(our_commit.id(), their_commit.id()) {
        Ok(base) => repo.find_commit(base).map_err(gerr)?.tree().map_err(gerr)?,
        Err(_) => empty_tree,
    };

    let mut merged_index = repo
        .merge_trees(
            &ancestor_tree,
            &our_tree,
            &their_tree,
            Some(MergeOptions::new().fail_on_conflict(false)),
        )
        .map_err(gerr)?;

    resolve_conflicts(repo, &mut merged_index)?;

    let merged_tree_oid = merged_index.write_tree_to(repo).map_err(gerr)?;
    let merged_tree = repo.find_tree(merged_tree_oid).map_err(gerr)?;

    // Summary: compare our pre-merge tree to the merged result.
    summary_diff(repo, &our_tree, &merged_tree, &mut summary)?;

    // Create the merge commit with both parents and update HEAD + working tree.
    repo.commit(
        Some("HEAD"),
        sig,
        sig,
        "Merge remote annotations",
        &merged_tree,
        &[&our_commit, &their_commit],
    )
    .map_err(gerr)?;
    checkout_annotations(repo, ann_rel)?;

    summary.pulled = true;
    Ok(summary)
}

/// Resolve every conflict in `index` in place: annotation files via [`set_merge`],
/// all others favor-incoming (theirs). Leaves `index` conflict-free.
fn resolve_conflicts(repo: &Repository, index: &mut git2::Index) -> Result<(), String> {
    // Collect first; we can't mutate the index while iterating its conflicts.
    struct C {
        path: String,
        ancestor: Option<git2::IndexEntry>,
        ours: Option<git2::IndexEntry>,
        theirs: Option<git2::IndexEntry>,
    }
    let mut conflicts: Vec<C> = Vec::new();
    {
        let iter = index.conflicts().map_err(gerr)?;
        for c in iter {
            let c = c.map_err(gerr)?;
            let path = entry_path(&c.our).or_else(|| entry_path(&c.their)).or_else(|| entry_path(&c.ancestor));
            if let Some(path) = path {
                conflicts.push(C {
                    path,
                    ancestor: c.ancestor,
                    ours: c.our,
                    theirs: c.their,
                });
            }
        }
    }

    for c in conflicts {
        index.remove_path(Path::new(&c.path)).ok();

        let is_annotation = c.path.ends_with(&format!(".{ANNOTATION_EXT}"));
        let resolved: Option<git2::IndexEntry> = if is_annotation {
            let anc = blob_text(repo, c.ancestor.as_ref());
            let ours = blob_text(repo, c.ours.as_ref());
            let theirs = blob_text(repo, c.theirs.as_ref());
            let merged = set_merge(&anc, &ours, &theirs);
            let oid = repo.blob(merged.as_bytes()).map_err(gerr)?;
            // Base the resolved entry on whichever side exists, then point it at
            // the merged blob with a zero (resolved) stage.
            c.ours.or(c.theirs).map(|mut e| {
                e.id = oid;
                normalize_entry(&mut e);
                e
            })
        } else {
            // Favor incoming; if theirs was deleted, drop ours by leaving the
            // path removed.
            c.theirs.map(|mut e| {
                normalize_entry(&mut e);
                e
            })
        };

        if let Some(entry) = resolved {
            index.add(&entry).map_err(gerr)?;
        }
        // else: deletion wins — path stays removed.
    }
    Ok(())
}

/// Clear the stage bits (0 = resolved/normal) on an index entry's flags.
fn normalize_entry(e: &mut git2::IndexEntry) {
    // Stage is stored in bits 12-13 of `flags`; clearing them marks it stage 0.
    e.flags &= !0x3000;
}

fn entry_path(entry: &Option<git2::IndexEntry>) -> Option<String> {
    entry
        .as_ref()
        .map(|e| String::from_utf8_lossy(&e.path).to_string())
}

fn blob_text(repo: &Repository, entry: Option<&git2::IndexEntry>) -> String {
    match entry {
        Some(e) => repo
            .find_blob(e.id)
            .ok()
            .map(|b| String::from_utf8_lossy(b.content()).to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

fn push(repo: &Repository, branch: &str, token: &str) -> Result<bool, String> {
    // Nothing to push if HEAD is unborn.
    if repo.head().is_err() {
        return Ok(false);
    }
    let mut remote = repo.find_remote(REMOTE_NAME).map_err(gerr)?;
    let mut po = PushOptions::new();
    po.remote_callbacks(credentials_callbacks(token));
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote
        .push(&[&refspec], Some(&mut po))
        .map_err(|e| remote_err("push to the remote", &e))?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Set-merge (the heart of the conflict-free annotation model)
// ---------------------------------------------------------------------------

/// Three-way set-merge of annotation file contents. Each non-empty line is one
/// record; identity is the exact line text. Returns the merged content sorted
/// by start time.
///
/// Rules (against the common `ancestor`):
/// - a line new on either side (not in ancestor) → keep (union of adds)
/// - a line in ancestor but removed on either side → drop (honor deletes)
/// - a line unchanged on both → keep
///
/// Consequence: two people adding to the same recording always union; a
/// deliberate delete propagates; nothing is silently lost. If both edit the
/// *extent* of the same label, that reads as delete-old + add-new on both
/// sides, so both edited copies are kept (overlapping duplicates) rather than
/// one being dropped — a known v1 tradeoff (no stable per-annotation IDs yet).
pub fn set_merge(ancestor: &str, ours: &str, theirs: &str) -> String {
    let a = line_set(ancestor);
    let o = line_set(ours);
    let t = line_set(theirs);

    let mut keep: BTreeSet<String> = BTreeSet::new();
    for line in o.iter().chain(t.iter()) {
        let in_a = a.contains(line);
        let in_o = o.contains(line);
        let in_t = t.contains(line);
        let survives = if in_a {
            in_o && in_t // present in ancestor: kept only if neither side removed it
        } else {
            true // new on a side: an add, keep it
        };
        if survives {
            keep.insert(line.clone());
        }
    }

    let mut lines: Vec<String> = keep.into_iter().collect();
    lines.sort_by(|x, y| start_of(x).total_cmp(&start_of(y)).then_with(|| x.cmp(y)));
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn line_set(s: &str) -> BTreeSet<String> {
    s.lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// Leading tab-delimited field parsed as a start time; non-numeric lines sort
/// last (large key) but stay stable via the secondary string compare.
fn start_of(line: &str) -> f64 {
    line.split('\t')
        .next()
        .and_then(|f| f.trim().parse::<f64>().ok())
        .unwrap_or(f64::INFINITY)
}

// ---------------------------------------------------------------------------
// Summary diff
// ---------------------------------------------------------------------------

/// Populate the annotation add/remove counts and changed-file list by comparing
/// annotation blobs between `before` and `after` trees.
fn summary_diff(
    repo: &Repository,
    before: &git2::Tree,
    after: &git2::Tree,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let before_files = annotation_blobs(repo, before)?;
    let after_files = annotation_blobs(repo, after)?;

    let mut paths: BTreeSet<&String> = BTreeSet::new();
    paths.extend(before_files.keys());
    paths.extend(after_files.keys());

    for path in paths {
        let before_lines = before_files.get(path).map(|s| line_set(s)).unwrap_or_default();
        let after_lines = after_files.get(path).map(|s| line_set(s)).unwrap_or_default();
        let added = after_lines.difference(&before_lines).count();
        let removed = before_lines.difference(&after_lines).count();
        if added > 0 || removed > 0 {
            summary.annotations_added += added;
            summary.annotations_removed += removed;
            summary.recordings_changed.push(path.clone());
        }
    }
    Ok(())
}

/// Map of repo-relative path → content for every annotation blob in a tree.
fn annotation_blobs(
    repo: &Repository,
    tree: &git2::Tree,
) -> Result<std::collections::HashMap<String, String>, String> {
    let suffix = format!(".{ANNOTATION_EXT}");
    let mut map = std::collections::HashMap::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Some(name) = entry.name() {
                if name.ends_with(&suffix) {
                    if let Ok(obj) = entry.to_object(repo) {
                        if let Some(blob) = obj.as_blob() {
                            let path = format!("{dir}{name}");
                            map.insert(
                                path,
                                String::from_utf8_lossy(blob.content()).to_string(),
                            );
                        }
                    }
                }
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(gerr)?;
    Ok(map)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn author_email(author: &str) -> String {
    // Synthesize a stable, valid local email from the typed name. Attribution
    // lives in the name; the email just has to parse.
    let slug: String = author
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "user" } else { slug };
    format!("{slug}@seenote.local")
}

fn gerr(e: git2::Error) -> String {
    e.message().to_string()
}

/// Count annotation lines added/removed (and files changed) between two tree states.
/// `before` is None when there was no prior remote state (first push).
/// Returns `(files_changed, added, removed)`.
fn tree_annotation_delta(
    repo: &Repository,
    before: Option<&git2::Tree>,
    after: &git2::Tree,
) -> Result<(usize, usize, usize), String> {
    let before_blobs = match before {
        Some(t) => annotation_blobs(repo, t)?,
        None => std::collections::HashMap::new(),
    };
    let after_blobs = annotation_blobs(repo, after)?;

    let mut all_paths: BTreeSet<String> = BTreeSet::new();
    all_paths.extend(before_blobs.keys().cloned());
    all_paths.extend(after_blobs.keys().cloned());

    let mut files_changed = 0usize;
    let mut annotations_added = 0usize;
    let mut annotations_removed = 0usize;
    for path in &all_paths {
        let before_lines = before_blobs.get(path).map(|s| line_set(s)).unwrap_or_default();
        let after_lines = after_blobs.get(path).map(|s| line_set(s)).unwrap_or_default();
        let added = after_lines.difference(&before_lines).count();
        let removed = before_lines.difference(&after_lines).count();
        if added > 0 || removed > 0 {
            files_changed += 1;
            annotations_added += added;
            annotations_removed += removed;
        }
    }
    Ok((files_changed, annotations_added, annotations_removed))
}

/// True if the remote tracking branch has commits not present in HEAD.
fn remote_is_ahead(repo: &Repository, branch: &str) -> Result<bool, String> {
    let remote_ref = format!("refs/remotes/{REMOTE_NAME}/{branch}");
    let remote_oid = match repo.refname_to_id(&remote_ref) {
        Ok(oid) => oid,
        Err(_) => return Ok(false),
    };
    let head_oid = match repo.head().ok().and_then(|h| h.target()) {
        Some(oid) => oid,
        None => return Ok(true), // remote has commits but we have none
    };
    if remote_oid == head_oid {
        return Ok(false);
    }
    let (_, behind) = repo.graph_ahead_behind(head_oid, remote_oid).map_err(gerr)?;
    Ok(behind > 0)
}

/// True if annotation files on disk differ from HEAD, or HEAD is ahead of the
/// remote tracking branch (unpushed commits).
fn has_local_annotation_changes(
    repo: &Repository,
    project_path: &Path,
    ann_rel: &Path,
) -> Result<bool, String> {
    // Check if HEAD is ahead of remote tracking branch (unpushed commits).
    let branch = current_branch(repo);
    let remote_ref = format!("refs/remotes/{REMOTE_NAME}/{branch}");
    if let Ok(remote_oid) = repo.refname_to_id(&remote_ref) {
        if let Some(head_oid) = repo.head().ok().and_then(|h| h.target()) {
            if head_oid != remote_oid {
                if let Ok((ahead, _)) = repo.graph_ahead_behind(head_oid, remote_oid) {
                    if ahead > 0 {
                        return Ok(true);
                    }
                }
            }
        }
    }

    // Compare annotation files on disk to HEAD blobs.
    let ann_abs = project_path.join(ann_rel);
    let head_blobs = match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(tree) => annotation_blobs(repo, &tree)?,
        None => {
            // No commits yet — any annotation file counts as a local change.
            let mut found = false;
            super::shared::walk_files(&ann_abs, &mut |p| {
                if p.extension().and_then(|e| e.to_str()) == Some(ANNOTATION_EXT) {
                    found = true;
                }
            });
            return Ok(found);
        }
    };

    let mut disk: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    super::shared::walk_files(&ann_abs, &mut |p| {
        if p.extension().and_then(|e| e.to_str()) != Some(ANNOTATION_EXT) {
            return;
        }
        if let Ok(rel) = p.strip_prefix(project_path) {
            let key = rel.to_string_lossy().replace('\\', "/");
            if let Ok(content) = std::fs::read_to_string(p) {
                disk.insert(key, content);
            }
        }
    });

    for (path, content) in &disk {
        match head_blobs.get(path.as_str()) {
            Some(head_content) if content == head_content => {}
            _ => return Ok(true),
        }
    }

    let ann_rel_posix = ann_rel.to_string_lossy().replace('\\', "/");
    for path in head_blobs.keys() {
        if path.starts_with(&ann_rel_posix) && !disk.contains_key(path.as_str()) {
            return Ok(true); // deleted on disk
        }
    }

    Ok(false)
}

fn local_sync_status_blocking(project_dir: &str, annotation_dir: &str) -> Result<SyncStatus, String> {
    let project_path = Path::new(project_dir);
    let ann_path = Path::new(annotation_dir);

    let repo = match Repository::open(project_path) {
        Ok(r) => r,
        Err(_) => return Ok(SyncStatus::default()),
    };

    let branch = current_branch(&repo);
    let ann_rel = match ann_path.strip_prefix(project_path) {
        Ok(r) => r.to_path_buf(),
        Err(_) => return Ok(SyncStatus::default()),
    };

    let has_local_changes = has_local_annotation_changes(&repo, project_path, &ann_rel)?;
    let has_remote_changes = remote_is_ahead(&repo, &branch)?;

    Ok(SyncStatus { has_local_changes, has_remote_changes })
}

fn fetch_remote_status_blocking(
    project_dir: &str,
    remote_url: &str,
    token: &str,
) -> Result<bool, String> {
    let project_path = Path::new(project_dir);
    let repo = match Repository::open(project_path) {
        Ok(r) => r,
        Err(_) => return Ok(false),
    };

    match repo.find_remote(REMOTE_NAME) {
        Ok(existing) => {
            if existing.url() != Some(remote_url) {
                repo.remote_set_url(REMOTE_NAME, remote_url).map_err(gerr)?;
            }
        }
        Err(_) => {
            repo.remote(REMOTE_NAME, remote_url).map_err(gerr)?;
        }
    }

    let branch = current_branch(&repo);
    fetch(&repo, &branch, token)?;
    remote_is_ahead(&repo, &branch)
}

// ---------------------------------------------------------------------------
// Tests — pin the set-merge semantics (the cornerstone of the no-conflict model).
// These mirror the TS annotation format in utils/helpers.ts; keep both in sync.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{is_auth_error, remote_err, set_merge, AUTH_ERROR_PREFIX};

    fn norm(s: &str) -> Vec<String> {
        s.lines().map(|l| l.to_string()).collect()
    }

    #[test]
    fn classifies_401_as_auth_error() {
        let e = git2::Error::from_str("request failed with status code: 401");
        assert!(is_auth_error(&e));
        assert!(remote_err("push to the remote", &e).starts_with(AUTH_ERROR_PREFIX));
    }

    #[test]
    fn classifies_token_rejection_as_auth_error() {
        let e = git2::Error::from_str("token rejected: 401 authentication failed");
        assert!(is_auth_error(&e));
    }

    #[test]
    fn non_auth_error_is_not_flagged() {
        // A network/DNS-style failure must NOT be reported as a token problem.
        let e = git2::Error::from_str("failed to resolve address for github.com");
        assert!(!is_auth_error(&e));
        assert!(!remote_err("reach the remote", &e).starts_with(AUTH_ERROR_PREFIX));
    }

    #[test]
    fn adds_only_union() {
        // Both started from the same file; each appended a different annotation.
        let ancestor = "1.0\t2.0\ta\n";
        let ours = "1.0\t2.0\ta\n3.0\t4.0\tb\n";
        let theirs = "1.0\t2.0\ta\n5.0\t6.0\tc\n";
        let merged = set_merge(ancestor, ours, theirs);
        assert_eq!(
            norm(&merged),
            vec!["1.0\t2.0\ta", "3.0\t4.0\tb", "5.0\t6.0\tc"]
        );
    }

    #[test]
    fn delete_is_honored() {
        // ours deletes record b; theirs left it untouched -> b is dropped.
        let ancestor = "1.0\t2.0\ta\n3.0\t4.0\tb\n";
        let ours = "1.0\t2.0\ta\n";
        let theirs = "1.0\t2.0\ta\n3.0\t4.0\tb\n";
        let merged = set_merge(ancestor, ours, theirs);
        assert_eq!(norm(&merged), vec!["1.0\t2.0\ta"]);
    }

    #[test]
    fn add_and_unrelated_delete() {
        // user1 adds c, user2 deletes a (different record), same file.
        let ancestor = "1.0\t2.0\ta\n3.0\t4.0\tb\n";
        let ours = "1.0\t2.0\ta\n3.0\t4.0\tb\n5.0\t6.0\tc\n"; // added c
        let theirs = "3.0\t4.0\tb\n"; // deleted a
        let merged = set_merge(ancestor, ours, theirs);
        // a deleted, b kept, c added.
        assert_eq!(norm(&merged), vec!["3.0\t4.0\tb", "5.0\t6.0\tc"]);
    }

    #[test]
    fn both_edit_extent_keeps_both() {
        // Both change the same label's extent -> two overlapping records kept
        // (no silent loss; documented v1 tradeoff).
        let ancestor = "10.0\t12.0\tL\n";
        let ours = "10.0\t13.0\tL\n";
        let theirs = "9.0\t12.0\tL\n";
        let merged = set_merge(ancestor, ours, theirs);
        assert_eq!(norm(&merged), vec!["9.0\t12.0\tL", "10.0\t13.0\tL"]);
    }

    #[test]
    fn sorted_by_start_time() {
        let merged = set_merge("", "5.0\t6.0\tc\n1.0\t2.0\ta\n", "3.0\t4.0\tb\n");
        assert_eq!(
            norm(&merged),
            vec!["1.0\t2.0\ta", "3.0\t4.0\tb", "5.0\t6.0\tc"]
        );
    }

    #[test]
    fn empty_result_has_no_trailing_newline() {
        assert_eq!(set_merge("1.0\t2.0\ta\n", "", ""), "");
    }
}
