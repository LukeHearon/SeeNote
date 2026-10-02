//! Three-way merge of the remote tracking branch into HEAD, with conflict
//! resolution (set-merge for annotations, favor-incoming otherwise).

use std::path::Path;

use git2::{MergeOptions, Repository, Signature};

use crate::commands::shared::ANNOTATION_EXT;

use super::annotate::{annotation_blobs, incoming_removals, resolve_annotation, set_merge, summary_diff};
use super::remote::remote_tracking_commit;
use super::{gerr, SyncSummary, INCOMING_CLEARS_PREFIX};

/// Update the working tree to HEAD, but ONLY under the annotation directory, so
/// a pull never touches the host repo's source files (matching the "SeeNote only
/// updates the annotations dir" contract). When the annotation dir is the repo
/// root, only annotation files (and the gitignore) are checked out.
fn checkout_annotations(repo: &Repository, ann_rel: &Path) -> Result<(), String> {
    let rel = ann_rel.to_string_lossy().replace('\\', "/");
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force();
    if !rel.is_empty() && rel != "." {
        cb.path(&rel);
    } else {
        // Annotation dir is the repo root: still only touch annotation files,
        // never a host repo's other (possibly dirty) files.
        cb.path(format!("*.{ANNOTATION_EXT}"));
        cb.path(".gitignore");
    }
    repo.checkout_head(Some(&mut cb)).map_err(gerr)
}

/// Merge the remote tracking branch into HEAD, resolving annotation files with
/// [`resolve_annotation`] (set-merge; remote whole-file deletions never applied)
/// and everything else favor-incoming.
///
/// `allow_incoming_clears` is false for the unattended auto-pull: if the remote
/// empties an annotation file we hold records for (a teammate's confirmed
/// clear), nothing is merged and the error starts with [`INCOMING_CLEARS_PREFIX`],
/// so destroying records always happens on a sync the user started.
pub(crate) fn merge_remote(
    repo: &Repository,
    branch: &str,
    ann_rel: &Path,
    sig: &Signature,
    allow_incoming_clears: bool,
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
            checkout_annotations(repo, ann_rel)?;
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

    // True three-way merge. When the histories are unrelated (no merge base —
    // e.g. the first sync where the local repo was init'd separately from a
    // remote that already has annotations), use an EMPTY tree as the base. That
    // makes every line on both sides read as an add, so every shared annotation
    // file becomes an add/add that set_merge resolves to the union — exactly
    // what we want. (Using our_tree as the base would instead make theirs win
    // wholesale and silently drop our-only lines.)
    let empty_tree = {
        let oid = repo.treebuilder(None).map_err(gerr)?.write().map_err(gerr)?;
        repo.find_tree(oid).map_err(gerr)?
    };
    let ancestor_tree = if analysis.is_fast_forward() {
        our_tree.clone()
    } else {
        match repo.merge_base(our_commit.id(), their_commit.id()) {
            Ok(base) => repo.find_commit(base).map_err(gerr)?.tree().map_err(gerr)?,
            Err(_) => empty_tree,
        }
    };

    let anc_blobs = annotation_blobs(repo, &ancestor_tree)?;
    let our_blobs = annotation_blobs(repo, &our_tree)?;
    let their_blobs = annotation_blobs(repo, &their_tree)?;

    let removals = incoming_removals(&anc_blobs, &their_blobs);
    if !removals.emptied.is_empty() && !allow_incoming_clears {
        return Err(format!(
            "{INCOMING_CLEARS_PREFIX} Remote changes clear {} annotation file(s) ({}). \
             Run Sync to apply them.",
            removals.emptied.len(),
            removals.emptied.join(", "),
        ));
    }
    summary.remote_clears = removals.emptied;
    summary.ignored_remote_deletions = removals.deleted;

    if analysis.is_fast_forward() && summary.ignored_remote_deletions.is_empty() {
        // No local commits ahead: just move HEAD and check out, then summarize
        // the incoming annotation delta. (A remote that deleted annotation files
        // takes the merge path below instead, which keeps them.)
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

    let mut merged_index = repo
        .merge_trees(
            &ancestor_tree,
            &our_tree,
            &their_tree,
            Some(MergeOptions::new().fail_on_conflict(false)),
        )
        .map_err(gerr)?;

    resolve_conflicts(repo, &mut merged_index)?;

    // Annotation files get the last word over git's textual result.
    let mut paths: Vec<&String> = anc_blobs.keys().chain(our_blobs.keys()).chain(their_blobs.keys()).collect();
    paths.sort();
    paths.dedup();
    for path in paths {
        let resolved = resolve_annotation(
            anc_blobs.get(path).map(String::as_str),
            our_blobs.get(path).map(String::as_str),
            their_blobs.get(path).map(String::as_str),
        );
        if let Some(content) = resolved {
            put_blob(repo, &mut merged_index, path, &content)?;
        }
    }

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

/// Write `content` as the resolved (stage 0) entry for `path`, replacing any
/// conflict stages or textual-merge result.
fn put_blob(repo: &Repository, index: &mut git2::Index, path: &str, content: &str) -> Result<(), String> {
    let oid = repo.blob(content.as_bytes()).map_err(gerr)?;
    index.remove_path(Path::new(path)).ok();
    let zero = git2::IndexTime::new(0, 0);
    index
        .add(&git2::IndexEntry {
            ctime: zero,
            mtime: zero,
            dev: 0,
            ino: 0,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            file_size: content.len() as u32,
            id: oid,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        })
        .map_err(gerr)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::make_tmp_root;
    use git2::Oid;

    fn sig() -> Signature<'static> {
        Signature::now("T", "t@seenote.local").unwrap()
    }

    /// Commit `files` (repo-relative path → content) on top of `parents`
    /// without moving any ref.
    fn commit(repo: &Repository, parents: &[Oid], files: &[(&str, &str)]) -> Oid {
        let mut idx = git2::Index::new().unwrap();
        for (p, c) in files {
            put_blob(repo, &mut idx, p, c).unwrap();
        }
        let tree = repo.find_tree(idx.write_tree_to(repo).unwrap()).unwrap();
        let parents: Vec<git2::Commit> = parents.iter().map(|o| repo.find_commit(*o).unwrap()).collect();
        let refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(None, &sig(), &sig(), "c", &tree, &refs).unwrap()
    }

    fn setup(ours: Oid, theirs: Oid, repo: &Repository) {
        repo.reference("refs/heads/main", ours, true, "t").unwrap();
        repo.set_head("refs/heads/main").unwrap();
        repo.reference("refs/remotes/origin/main", theirs, true, "t").unwrap();
    }

    fn head_file(repo: &Repository, path: &str) -> Option<String> {
        let tree = repo.head().ok()?.peel_to_tree().ok()?;
        let entry = tree.get_path(Path::new(path)).ok()?;
        let blob = repo.find_blob(entry.id()).ok()?;
        Some(String::from_utf8_lossy(blob.content()).to_string())
    }

    #[test]
    fn remote_file_deletion_is_never_applied() {
        let root = make_tmp_root("merge_del");
        let repo = Repository::init(&root).unwrap();
        let a = "1\t2\tx\n";
        let base = commit(&repo, &[], &[("ann/a.txt", a), ("ann/b.txt", "3\t4\ty\n")]);
        let theirs = commit(&repo, &[base], &[("ann/b.txt", "3\t4\ty\n5\t6\tz\n")]);
        setup(base, theirs, &repo);

        let summary = merge_remote(&repo, "main", Path::new("ann"), &sig(), false).unwrap();

        assert!(summary.pulled);
        assert_eq!(summary.ignored_remote_deletions, vec!["ann/a.txt".to_string()]);
        assert_eq!(head_file(&repo, "ann/a.txt").as_deref(), Some(a));
        assert_eq!(head_file(&repo, "ann/b.txt").as_deref(), Some("3\t4\ty\n5\t6\tz\n"));
        assert_eq!(std::fs::read_to_string(root.join("ann/a.txt")).unwrap(), a);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn auto_pull_refuses_an_incoming_clear_but_manual_sync_applies_it() {
        let root = make_tmp_root("merge_clear");
        let repo = Repository::init(&root).unwrap();
        let base = commit(&repo, &[], &[("ann/a.txt", "1\t2\tx\n")]);
        let theirs = commit(&repo, &[base], &[("ann/a.txt", "")]);
        setup(base, theirs, &repo);

        let err = merge_remote(&repo, "main", Path::new("ann"), &sig(), false).unwrap_err();
        assert!(err.starts_with(INCOMING_CLEARS_PREFIX), "{err}");
        assert_eq!(repo.head().unwrap().target(), Some(base), "auto-pull moved HEAD");

        let summary = merge_remote(&repo, "main", Path::new("ann"), &sig(), true).unwrap();
        assert_eq!(summary.remote_clears, vec!["ann/a.txt".to_string()]);
        assert_eq!(head_file(&repo, "ann/a.txt").as_deref(), Some(""));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn non_conflicting_two_sided_edit_is_set_merged_not_duplicated() {
        let root = make_tmp_root("merge_dup");
        let repo = Repository::init(&root).unwrap();
        let base_txt = "1\t2\tx\n5\t6\ty\n7\t8\tw\n9\t10\tz\n";
        let base = commit(&repo, &[], &[("ann/a.txt", base_txt)]);
        // Same new record, added at different places on each side: git's hunk
        // merge would keep both copies.
        let ours = commit(&repo, &[base], &[("ann/a.txt", "1\t2\tx\n3\t4\tn\n5\t6\ty\n7\t8\tw\n9\t10\tz\n")]);
        let theirs = commit(&repo, &[base], &[("ann/a.txt", "1\t2\tx\n5\t6\ty\n7\t8\tw\n9\t10\tz\n3\t4\tn\n")]);
        setup(ours, theirs, &repo);

        merge_remote(&repo, "main", Path::new("ann"), &sig(), false).unwrap();

        assert_eq!(
            head_file(&repo, "ann/a.txt").as_deref(),
            Some("1\t2\tx\n3\t4\tn\n5\t6\ty\n7\t8\tw\n9\t10\tz\n")
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
