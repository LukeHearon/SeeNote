mod audio;
mod commands;

pub fn run() {
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
            commands::projects::get_app_data_dir,
            commands::projects::load_projects,
            commands::projects::save_projects,
            commands::projects::read_project_settings,
            commands::projects::write_project_settings,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
