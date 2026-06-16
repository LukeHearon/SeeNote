use keyring::Entry;

const SERVICE: &str = "com.seenote.app";

#[tauri::command]
pub fn get_git_credential(remote_url: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &remote_url).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn set_git_credential(remote_url: String, token: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &remote_url).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_git_credential(remote_url: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &remote_url).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
