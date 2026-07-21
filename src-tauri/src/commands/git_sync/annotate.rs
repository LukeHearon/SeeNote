//! The annotation set-merge (the heart of the conflict-free model) and the
//! tree-diff helpers that summarize annotation changes.

use std::collections::{BTreeSet, HashMap};

use git2::{Repository, Tree};

use crate::commands::shared::ANNOTATION_EXT;

use super::{gerr, SyncSummary};

// ---------------------------------------------------------------------------
// Record identity (numeric-aware canonical key)
// ---------------------------------------------------------------------------

/// Canonical identity of one annotation record, so that two textual
/// representations of the *same* record compare equal.
///
/// The app re-serializes times at its `outputRoundingDecimals` setting, so the
/// same annotation can be written as `1.234` on one machine and `1.23400` on
/// another. Keying on exact line text would read that as delete+add and churn
/// every teammate's file; keying on the numeric value makes it a no-op.
///
/// Rule (mirrored on the TS side in `utils/annotationMerge.ts` `canonicalKey` /
/// `setMergeContent` — keep both in sync): split the line on tabs;
/// if the first two fields parse as `f64`, the key is the bit patterns of
/// (start, end) plus the untouched remainder of the line (the label and any
/// further fields). Non-numeric lines fall back to their exact text.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum RecordKey {
    /// Leading start/end parsed numerically; `rest` is the raw remainder of the
    /// line after the second tab (label and any extra columns), kept verbatim.
    Timed { start: u64, end: u64, rest: String },
    /// Line whose first two fields aren't both numeric — identity is exact text.
    Raw(String),
}

/// Compute the canonical [`RecordKey`] for one already-trimmed line.
pub(crate) fn record_key(line: &str) -> RecordKey {
    let mut fields = line.splitn(3, '\t');
    let start = fields.next();
    let end = fields.next();
    let rest = fields.next().unwrap_or("");
    if let (Some(s), Some(e)) = (start, end) {
        if let (Ok(start), Ok(end)) = (s.trim().parse::<f64>(), e.trim().parse::<f64>()) {
            return RecordKey::Timed {
                start: start.to_bits(),
                end: end.to_bits(),
                rest: rest.to_string(),
            };
        }
    }
    RecordKey::Raw(line.to_string())
}

/// Map each record's canonical key to a representative line text. Blank lines
/// are dropped; on a key collision the first occurrence's text wins.
pub(crate) fn line_map(s: &str) -> HashMap<RecordKey, String> {
    let mut map = HashMap::new();
    for line in s.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        map.entry(record_key(line)).or_insert_with(|| line.to_string());
    }
    map
}

/// The set of canonical record keys in a file — used to compare two files by
/// record identity (ignoring precision-only textual differences).
pub(crate) fn line_key_set(s: &str) -> BTreeSet<RecordKey> {
    line_map(s).into_keys().collect()
}

// ---------------------------------------------------------------------------
// Set-merge (the heart of the conflict-free annotation model)
// ---------------------------------------------------------------------------

/// Three-way set-merge of annotation file contents. Each non-empty line is one
/// record; identity is the canonical [`RecordKey`] (numeric-aware, so a
/// precision-only rewrite is a no-op). Returns the merged content sorted by
/// start time.
///
/// Rules (against the common `ancestor`):
/// - a record new on either side (not in ancestor) → keep (union of adds)
/// - a record in ancestor but removed on either side → drop (honor deletes)
/// - a record unchanged on both → keep
///
/// When several textual representations of the same record exist, the output
/// text preference is ancestor → theirs → ours, so an unchanged record keeps
/// its stored text (`1.234` is not overwritten by `1.23400`).
///
/// Consequence: two people adding to the same recording always union; a
/// deliberate delete propagates; nothing is silently lost. If both edit the
/// *extent* of the same label, that reads as delete-old + add-new on both
/// sides, so both edited copies are kept (overlapping duplicates) rather than
/// one being dropped — a known v1 tradeoff (no stable per-annotation IDs yet).
pub fn set_merge(ancestor: &str, ours: &str, theirs: &str) -> String {
    let a = line_map(ancestor);
    let o = line_map(ours);
    let t = line_map(theirs);

    let mut keep: BTreeSet<String> = BTreeSet::new();
    for key in o.keys().chain(t.keys()) {
        let in_a = a.contains_key(key);
        let survives = if in_a {
            o.contains_key(key) && t.contains_key(key) // kept only if neither side removed it
        } else {
            true // new on a side: an add, keep it
        };
        if survives {
            // Output-text preference: ancestor's text if unchanged, else theirs,
            // else ours — so a precision-only rewrite keeps the stored text.
            if let Some(text) = a.get(key).or_else(|| t.get(key)).or_else(|| o.get(key)) {
                keep.insert(text.clone());
            }
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
        let before_lines = before_files.get(path).map(|s| line_key_set(s)).unwrap_or_default();
        let after_lines = after_files.get(path).map(|s| line_key_set(s)).unwrap_or_default();
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
        let before_lines = before_blobs.get(path).map(|s| line_key_set(s)).unwrap_or_default();
        let after_lines = after_blobs.get(path).map(|s| line_key_set(s)).unwrap_or_default();
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
    use super::{line_key_set, record_key, set_merge, RecordKey};
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

    // ── numeric record identity (precision no-op) ─────────────────────────────

    #[test]
    fn record_key_ignores_decimal_precision() {
        // Same times, different serialized precision -> same key.
        assert_eq!(record_key("1.234\t2.5\ta"), record_key("1.23400\t2.50000\ta"));
        assert_eq!(record_key("3\t4\tb"), record_key("3.0\t4.00\tb"));
        // Different numeric value or label -> different key.
        assert_ne!(record_key("1.234\t2.5\ta"), record_key("1.235\t2.5\ta"));
        assert_ne!(record_key("1.234\t2.5\ta"), record_key("1.234\t2.5\tb"));
        // Non-numeric leading fields fall back to exact-text identity.
        assert!(matches!(record_key("hdr\tfoo\tbar"), RecordKey::Raw(_)));
        assert_ne!(record_key("hdr\tfoo"), record_key("hdr\tbar"));
    }

    #[test]
    fn precision_rewrite_is_a_noop_keeping_ancestor_text() {
        // Our side re-serialized the same record at more decimals; theirs is
        // untouched. Result must be the ancestor's stored text (no churn).
        let ancestor = "1.234\t2.5\ta\n";
        let ours = "1.23400\t2.50000\ta\n";
        let theirs = "1.234\t2.5\ta\n";
        let merged = set_merge(ancestor, ours, theirs);
        assert_eq!(norm(&merged), vec!["1.234\t2.5\ta"]);
    }

    #[test]
    fn new_record_on_both_sides_prefers_theirs_text() {
        // Not in ancestor; both sides added the same record at different
        // precision. Output-text preference is theirs over ours.
        let merged = set_merge("", "1.2\t3.4\tx\n", "1.20\t3.40\tx\n");
        assert_eq!(norm(&merged), vec!["1.20\t3.40\tx"]);
    }

    #[test]
    fn precision_rewrite_counts_zero_changes() {
        // line_key_set (what summary_diff / tree_annotation_delta count on) sees
        // no adds or removes for a precision-only rewrite.
        let before = line_key_set("1.234\t2.5\ta\n3.0\t4.0\tb\n");
        let after = line_key_set("1.23400\t2.50000\ta\n3\t4\tb\n");
        assert_eq!(after.difference(&before).count(), 0);
        assert_eq!(before.difference(&after).count(), 0);
    }

    #[test]
    fn precision_change_does_not_defeat_a_real_delete() {
        // ours deletes b and rewrites a at new precision; the delete is still
        // honored and a survives with ancestor text.
        let ancestor = "1.234\t2.5\ta\n3.0\t4.0\tb\n";
        let ours = "1.23400\t2.50000\ta\n";
        let theirs = "1.234\t2.5\ta\n3.0\t4.0\tb\n";
        let merged = set_merge(ancestor, ours, theirs);
        assert_eq!(norm(&merged), vec!["1.234\t2.5\ta"]);
    }
}
