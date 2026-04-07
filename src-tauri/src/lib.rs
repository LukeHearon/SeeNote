mod audio;
mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::audio::get_file_info,
            commands::audio::get_spectrogram_chunk,
            commands::audio::get_overview_spectrogram,
            commands::filesystem::list_directory,
            commands::filesystem::list_media_files_recursive,
            commands::filesystem::write_text_file,
            commands::filesystem::read_text_file,
            commands::filesystem::open_file_dialog,
            commands::filesystem::open_directory_dialog,
            commands::filesystem::open_file_or_folder_dialog,
            commands::filesystem::save_file_dialog,
            commands::projects::get_app_data_dir,
            commands::projects::load_projects,
            commands::projects::save_projects,
            commands::projects::get_orphaned_annotations,
            commands::projects::delete_files,
            commands::projects::copy_annotation_files,
            commands::projects::list_txt_files_recursive,
            commands::projects::reveal_in_finder,
            commands::projects::count_annotation_entries,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
