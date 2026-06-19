//! Three-way merge of the remote tracking branch into HEAD, with conflict
//! resolution (set-merge for annotations, favor-incoming otherwise).

use std::path::Path;

use git2::{MergeOptions, Repository, Signature};

use crate::commands::shared::ANNOTATION_EXT;

use super::annotate::{set_merge, summary_diff};
use super::remote::remote_tracking_commit;
use super::{gerr, SyncSummary};

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
pub(crate) fn merge_remote(
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
