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

mod annotate;
mod auth;
mod merge;
mod remote;
mod repo;

use std::path::Path;

use git2::{Repository, Signature};
use serde::Serialize;

use annotate::tree_annotation_delta;
use merge::merge_remote;
use remote::{fetch, push};
use repo::{
    current_branch, ensure_on_branch, has_local_annotation_changes, open_or_init, remote_is_ahead,
    stage_and_commit, write_gitignore,
};

/// Branch SeeNote syncs on. Single shared branch keeps the model simple; the
/// lab works off one line of history.
/// Branch used only when SeeNote freshly inits a repo (unborn/detached HEAD).
/// Otherwise the repo's current branch is used.
pub(crate) const DEFAULT_BRANCH: &str = "main";
pub(crate) const REMOTE_NAME: &str = "origin";

/// Prefix on error messages caused by GitHub rejecting the access token (401).
/// The frontend keys on this to show a token-specific message rather than a
/// generic "sync failed". We can't distinguish expired from revoked at the git
/// protocol level — both are a 401 — so the message covers both.
pub(crate) const AUTH_ERROR_PREFIX: &str = "AUTH_FAILED:";

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

pub(crate) fn gerr(e: git2::Error) -> String {
    e.message().to_string()
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
