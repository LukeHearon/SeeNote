use serde::Serialize;

#[derive(Serialize)]
pub struct DiagnosticInfo {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// Version of the system webview actually rendering the UI: WebView2 on
    /// Windows, WKWebView on macOS, WebKitGTK on Linux. The one piece of the
    /// environment that varies per machine and that SeeNote doesn't ship, so
    /// it's the first thing worth knowing when a UI bug reproduces on one
    /// user's Windows box and nowhere else. `Err` when the runtime is missing
    /// or unreadable, which is itself the answer in that case.
    pub webview: String,
    /// Only ever "debug" under `tauri dev` — an installed build is always
    /// "release", so the frontend hides it unless it says otherwise.
    pub build: String,
}

#[tauri::command]
pub fn get_diagnostic_info(app: tauri::AppHandle) -> DiagnosticInfo {
    DiagnosticInfo {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        webview: tauri::webview_version().unwrap_or_else(|e| format!("unavailable ({e})")),
        build: if cfg!(debug_assertions) { "debug".into() } else { "release".into() },
    }
}
