//! Credentials and auth-error classification for remote git operations.

use git2::{Cred, RemoteCallbacks};

use super::AUTH_ERROR_PREFIX;

pub(crate) fn credentials_callbacks(token: &str) -> RemoteCallbacks<'_> {
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
pub(crate) fn is_auth_error(e: &git2::Error) -> bool {
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
pub(crate) fn remote_err(action: &str, e: &git2::Error) -> String {
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
