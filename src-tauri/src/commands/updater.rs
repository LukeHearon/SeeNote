use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// Re-checks rather than reusing a handle from `check_for_update`: the `Update`
// object isn't trivially storable between separate command invocations, and a
// fresh check right before installing is cheap and avoids acting on stale data.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("No update available".into());
    };
    update
        .download_and_install(|_chunk_len, _content_len| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

// The AppImage format is the only Linux bundle the updater can replace in
// place; a `.deb` install has no matching artifact to swap in, so those users
// fall back to manually downloading from the GitHub releases page. AppImage
// sets this env var to its own path at launch (see AppImage docs); a `.deb`
// install won't have it set.
#[tauri::command]
pub fn is_update_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

// Restricted to https://github.com/... since this is exposed to the frontend;
// callers pass either the releases page or a project's repo URL, but the
// check keeps this command from becoming an arbitrary local-open primitive.
#[tauri::command]
pub fn open_github_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Refusing to open a non-GitHub URL".into());
    }
    open::that(url).map_err(|e| e.to_string())
}
