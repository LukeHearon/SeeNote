mod audio;
mod commands;

use tauri::Manager;

/// On Linux, WebKitGTK plays Fast-mode `<video>` through GStreamer. On this stack
/// (Ubuntu 24.04, WebKitGTK 2.52, GStreamer 1.24) the pipeline is prone to an
/// intermittent preroll/clock stall a fraction of a second into playback. Two
/// elements widen that race window: `pulsesink` (GStreamer's default clock provider,
/// with a known libpulse 16.1 clock bug on this stack) and `nvh264dec` (NVIDIA async
/// hardware decode). Demoting a feature's rank to 0 means "never auto-select it".
///
/// We demote ONLY `pulsesink` (→ pipewiresink here, alsasink elsewhere), because its
/// libpulse bug is a distinct, well-documented defect. `nvh264dec` is left ENABLED:
/// disabling it forces software `avdec_h264` (a real perf cost, and it also slows
/// Accurate-mode WebCodecs, which is GStreamer-backed here) yet still didn't fully
/// stop the stall — so it was only ever masking a race, not fixing it. Instead the
/// residual stall is caught by VideoElementEngine's Linux stall watchdog, which
/// recovers it with a pause/re-play (the same thing that recovers it by hand).
/// [If that watchdog proves insufficient with hardware decode on, re-add
/// `nvh264dec:0` here.]
///
/// GStreamer reads this env var when it first builds its plugin-feature registry, so
/// it MUST be set before WebKitGTK initializes GStreamer (i.e. before the first
/// WebView), hence at the very top of run(). An existing value is respected so a
/// developer can override it from the shell (e.g. re-add nvh264dec:0, or clear it).
///
/// Linux-only: macOS/Windows use their platform WebViews (no GStreamer) and are
/// unaffected by this bug, so their playback path is left exactly as-is.
#[cfg(target_os = "linux")]
fn configure_linux_gstreamer() {
    const KEY: &str = "GST_PLUGIN_FEATURE_RANK";
    if let Some(existing) = std::env::var_os(KEY) {
        eprintln!(
            "[gstreamer] respecting existing {KEY}={} (not overriding)",
            existing.to_string_lossy()
        );
        return;
    }
    let ranks = "pulsesink:0";
    std::env::set_var(KEY, ranks);
    eprintln!("[gstreamer] set {KEY}={ranks} (Linux Fast-mode <video> playback workaround)");
}

/// Picks the file path out of argv (a second-instance relaunch, or a
/// Windows/Linux cold start) since argv can otherwise contain arbitrary
/// launcher flags. Recognizes the same extensions as `shared::AUDIO_EXTS` /
/// `shared::VIDEO_EXTS` (the file-scanning classifier) rather than a separate
/// hand-copied list.
fn openable_path_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    use commands::shared::{AUDIO_EXTS, VIDEO_EXTS};
    args.into_iter().find(|arg| {
        std::path::Path::new(arg)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let e = e.to_lowercase();
                AUDIO_EXTS.contains(&e.as_str()) || VIDEO_EXTS.contains(&e.as_str())
            })
            .unwrap_or(false)
    })
}

/// Stash a just-launched/relaunched file path for the frontend to pick up, and
/// emit it live in case a listener is already attached (the already-running
/// case — a fresh cold start races the frontend's first render, so it relies
/// on draining `PendingOpenFile` via `take_pending_open_file` instead).
fn deliver_open_file(app: &tauri::AppHandle, path: String) {
    use tauri::Emitter;
    if let Some(state) = app.try_state::<commands::window::PendingOpenFile>() {
        *state.0.lock().unwrap() = Some(path.clone());
    }
    let _ = app.emit("open-file", path);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_gstreamer();

    tauri::Builder::default()
        // Must be registered before other plugins per tauri-plugin-single-instance docs.
        // Fires in the FIRST instance when a second launch (e.g. another "Open With
        // SeeNote") is caught and forwarded here instead of opening a duplicate window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = openable_path_from_args(argv.into_iter().skip(1)) {
                deliver_open_file(app, path);
            } else if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // manage() after plugin registration is fine — Tauri inserts state into the
        // app container regardless of call order relative to plugins.
        .manage(commands::audio::PcmStreamState::default())
        .manage(commands::window::PendingOpenFile::default())
        .setup(|app| {
            // Windows/Linux hand the launched file to us as a CLI arg on cold start
            // (macOS instead fires RunEvent::Opened below, so this is a no-op there —
            // Finder-launched processes get no meaningful argv).
            if let Some(path) = openable_path_from_args(std::env::args().skip(1)) {
                deliver_open_file(&app.handle().clone(), path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::audio::get_file_info,
            commands::audio::audio_peak,
            commands::audio::get_spectrogram_chunk,
            commands::audio::start_pcm_stream,
            commands::audio::read_pcm_chunk,
            commands::audio::close_pcm_stream,
            commands::filesystem::list_directory,
            commands::filesystem::list_media_files_recursive,
            commands::filesystem::write_text_file,
            commands::filesystem::read_text_file,
            commands::filesystem::open_directory_dialog,
            commands::filesystem::open_directory_dialog_at,
            commands::filesystem::save_file_dialog,
            commands::filesystem::open_file_dialog,
            commands::filesystem::open_files_dialog,
            commands::filesystem::remove_file,
            commands::filesystem::check_dir_exists,
            commands::filesystem::list_non_media_files_recursive,
            commands::filesystem::save_copy_overrides,
            commands::filesystem::apply_copy_overrides,
            commands::projects::get_app_data_dir,
            commands::projects::load_projects,
            commands::projects::save_projects,
            commands::projects::load_recent_files,
            commands::projects::save_recent_files,
            commands::projects::read_project_settings,
            commands::projects::write_project_settings,
            commands::projects::read_project_preferences,
            commands::projects::write_project_preferences,
            commands::projects::project_dir_exists,
            commands::projects::create_dir_all,
            commands::projects::get_orphaned_annotations,
            commands::projects::delete_files,
            commands::projects::copy_annotation_files,
            commands::projects::list_txt_files_recursive,
            commands::projects::reveal_in_file_manager,
            commands::projects::list_annotation_files,
            commands::window::get_window_bounds,
            commands::window::set_window_bounds,
            commands::window::open_sync_guide_window,
            commands::window::close_sync_guide_window,
            commands::window::open_copy_editor_window,
            commands::window::take_pending_open_file,
            commands::buzzdetect::read_buzzdetect,
            commands::annotation_tools::list_annotation_tools,
            commands::annotation_tools::list_tool_examples,
            commands::annotation_tools::create_annotation_tool,
            commands::annotation_tools::update_annotation_tool,
            commands::annotation_tools::rename_annotation_tool,
            commands::annotation_tools::delete_annotation_tool,
            commands::annotation_tools::import_tool_examples,
            commands::annotation_tools::import_examples_to_tool,
            commands::annotation_tools::import_annotation_tools,
            commands::git_sync::sync_project,
            commands::git_sync::get_local_sync_status,
            commands::git_sync::fetch_remote_status,
            commands::credentials::get_git_credential,
            commands::credentials::set_git_credential,
            commands::credentials::delete_git_credential,
            commands::video_server::get_video_server_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers "Open With SeeNote" launches as file:// URLs via this
            // event rather than argv (see openable_path_from_args's setup-hook use
            // for the Windows/Linux cold-start equivalent). RunEvent::Opened only
            // exists on macOS/iOS (see tauri's app.rs), hence the cfg gate.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(path) = urls.into_iter().find_map(|url| url.to_file_path().ok()) {
                    deliver_open_file(_app, path.to_string_lossy().into_owned());
                }
            }
        });
}
