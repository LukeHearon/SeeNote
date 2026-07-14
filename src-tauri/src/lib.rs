mod audio;
mod commands;

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

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_gstreamer();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // manage() after plugin registration is fine — Tauri inserts state into the
        // app container regardless of call order relative to plugins.
        .manage(commands::audio::PcmStreamState::default())
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
