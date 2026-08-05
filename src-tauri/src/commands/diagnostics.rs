use serde::Serialize;

#[derive(Serialize)]
pub struct DiagnosticInfo {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub build: String,
}

#[tauri::command]
pub fn get_diagnostic_info(app: tauri::AppHandle) -> DiagnosticInfo {
    DiagnosticInfo {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        build: if cfg!(debug_assertions) { "debug".into() } else { "release".into() },
    }
}
