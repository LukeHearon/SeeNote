use keyring::Entry;

const SERVICE: &str = "com.seenote.app";

#[tauri::command]
pub fn get_git_credential(remote_url: String) -> Result<Option<String>, String> {
    let account = normalize_remote_url(&remote_url);
    match get_account_password(&account) {
        Ok(Some(token)) => Ok(Some(token)),
        Ok(None) if account != remote_url => get_account_password(&remote_url),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn set_git_credential(remote_url: String, token: String) -> Result<(), String> {
    let account = normalize_remote_url(&remote_url);
    let entry = Entry::new(SERVICE, &account)
        .map_err(|e| format!("Could not open OS credential store: {e}"))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("Could not save access token to OS credential store: {e}"))?;

    let stored = entry
        .get_password()
        .map_err(|e| format!("Saved token, but could not read it back from OS credential store: {e}"))?;
    if stored != token {
        return Err("Saved token, but OS credential store returned a different value.".into());
    }

    if account != remote_url {
        let _ = delete_account_password(&remote_url);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_git_credential(remote_url: String) -> Result<(), String> {
    let account = normalize_remote_url(&remote_url);
    delete_account_password(&account)?;
    if account != remote_url {
        delete_account_password(&remote_url)?;
    }
    Ok(())
}

fn get_account_password(account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, account)
        .map_err(|e| format!("Could not open OS credential store: {e}"))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read access token from OS credential store: {e}")),
    }
}

fn delete_account_password(account: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, account)
        .map_err(|e| format!("Could not open OS credential store: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete access token from OS credential store: {e}")),
    }
}

fn normalize_remote_url(remote_url: &str) -> String {
    let trimmed = remote_url.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.ends_with(".git") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.git")
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_remote_url;

    #[test]
    fn normalizes_git_remote_url_for_keyring_account() {
        assert_eq!(
            normalize_remote_url(" https://github.com/lab/annotations/ "),
            "https://github.com/lab/annotations.git"
        );
        assert_eq!(
            normalize_remote_url("https://github.com/lab/annotations.git"),
            "https://github.com/lab/annotations.git"
        );
        assert_eq!(normalize_remote_url("   "), "");
    }
}
