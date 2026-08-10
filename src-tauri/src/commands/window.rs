use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// A file path handed to us at OS launch (file-association "Open With", or a
/// second-instance relaunch forwarded by tauri-plugin-single-instance) before
/// the frontend has had a chance to attach its `open-file` event listener.
/// The frontend drains this once on mount via `take_pending_open_file`, in
/// addition to listening for the live event — see lib.rs.
#[derive(Default)]
pub struct PendingOpenFile(pub Mutex<Option<String>>);

#[tauri::command]
pub fn take_pending_open_file(state: tauri::State<PendingOpenFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

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

// The three window-creating commands below MUST stay `async`.
//
// A sync #[tauri::command] runs inline on the thread that received the IPC
// message, which on Windows is the main/UI thread (wry serves the ipc protocol
// straight from WebView2's WebResourceRequested handler). Building a webview
// from there deadlocks: WebView2 controller creation runs a nested message pump
// that never gets its completion callback, because WebView2 won't deliver
// events re-entrantly while one of its own handlers is on the stack. Tauri
// documents this on WebviewWindowBuilder::new — "On Windows, this function
// deadlocks when used in a synchronous command".
//
// The symptom is not a crash: the OS window and title bar appear, the client
// area stays blank, and every later invoke from any window hangs forever, so
// the app looks alive but stops loading spectrograms until it's restarted.
// Reported against v0.16.1, which was the first release where opening the
// guide (its own window since d4ab9b2) made most Windows users create a second
// webview at all.
//
// Marking them async moves the body onto the async runtime, so the window
// request reaches the event loop through the proxy instead of being handled
// inside the WebView2 callback.
#[tauri::command]
pub async fn open_sync_guide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("sync-guide") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "sync-guide",
        WebviewUrl::App("index.html?window=sync-guide".into()),
    )
    .title("Set up syncing")
    .inner_size(720.0, 780.0)
    .min_inner_size(500.0, 400.0)
    .center()
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_sync_guide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("sync-guide") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open (or focus) the help guide window. `page` selects the guide page to land
/// on; when the window already exists the frontend is told to navigate there
/// over the `seenote-help` BroadcastChannel, so we only need to focus it here.
#[tauri::command]
pub async fn open_help_window(app: tauri::AppHandle, page: Option<String>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("help") {
        win.unminimize().ok();
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = match page.as_deref() {
        Some(p) if !p.is_empty() => format!("index.html?window=help&page={p}"),
        _ => "index.html?window=help".to_string(),
    };
    WebviewWindowBuilder::new(&app, "help", WebviewUrl::App(url.into()))
        .title("SeeNote Guide")
        .inner_size(1100.0, 760.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_help_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("help") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_copy_editor_window(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("copy-editor").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "copy-editor",
        WebviewUrl::App("index.html?window=copy-editor".into()),
    )
    .title("Copy Editor")
    .inner_size(780.0, 620.0)
    .min_inner_size(500.0, 300.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
