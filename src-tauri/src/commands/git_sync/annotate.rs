//! The annotation set-merge (the heart of the conflict-free model) and the
//! tree-diff helpers that summarize annotation changes.

use std::collections::BTreeSet;

use git2::{Repository, Tree};

use crate::commands::shared::ANNOTATION_EXT;

use super::{gerr, SyncSummary};

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

pub(crate) fn line_set(s: &str) -> BTreeSet<String> {
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
pub(crate) fn summary_diff(
    repo: &Repository,
    before: &Tree,
    after: &Tree,
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
pub(crate) fn annotation_blobs(
    repo: &Repository,
    tree: &Tree,
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

/// Count annotation lines added/removed (and files changed) between two tree states.
/// `before` is None when there was no prior remote state (first push).
/// Returns `(files_changed, added, removed)`.
pub(crate) fn tree_annotation_delta(
    repo: &Repository,
    before: Option<&Tree>,
    after: &Tree,
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

// ---------------------------------------------------------------------------
// Tests — pin the set-merge semantics (the cornerstone of the no-conflict model).
// These mirror the TS annotation format in utils/helpers.ts; keep both in sync.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::set_merge;
    use crate::commands::git_sync::auth::{is_auth_error, remote_err};
    use crate::commands::git_sync::AUTH_ERROR_PREFIX;

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
