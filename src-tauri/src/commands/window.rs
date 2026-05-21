use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn get_window_bounds(app: tauri::AppHandle) -> Result<WindowBounds, String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(WindowBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

#[tauri::command]
pub fn set_window_bounds(app: tauri::AppHandle, bounds: WindowBounds) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}
