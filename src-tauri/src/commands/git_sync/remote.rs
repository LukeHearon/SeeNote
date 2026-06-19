//! Fetch and push against the remote, plus remote-tracking lookups.

use git2::{AnnotatedCommit, FetchOptions, PushOptions, Repository};

use super::auth::{credentials_callbacks, is_auth_error, remote_err};
use super::{gerr, REMOTE_NAME};

pub(crate) fn fetch(repo: &Repository, branch: &str, token: &str) -> Result<(), String> {
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

pub(crate) fn remote_tracking_commit<'a>(
    repo: &'a Repository,
    branch: &str,
) -> Option<AnnotatedCommit<'a>> {
    let oid = repo
        .refname_to_id(&format!("refs/remotes/{REMOTE_NAME}/{branch}"))
        .ok()?;
    repo.find_annotated_commit(oid).ok()
}

pub(crate) fn push(repo: &Repository, branch: &str, token: &str) -> Result<bool, String> {
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
