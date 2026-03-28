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
            commands::filesystem::write_text_file,
            commands::filesystem::open_file_dialog,
            commands::filesystem::open_directory_dialog,
            commands::filesystem::save_file_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
