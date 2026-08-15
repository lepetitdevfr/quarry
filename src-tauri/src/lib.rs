pub mod commands;
pub mod conn;
pub mod error;
pub mod exec;
pub mod library;
pub mod schema;
pub mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 needs a process-level crypto provider installed before
    // any `ClientConfig::builder()` call (see conn::pool::make_tls), or it
    // panics at first use. Only the `aws-lc-rs` provider is compiled in
    // (see Cargo.toml), so install that one, once, here at startup.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(
            commands::AppState::new().expect("could not open the query library database"),
        )
        .invoke_handler(tauri::generate_handler![
            commands::execute,
            commands::disconnect,
            commands::active_connection,
            commands::library_tree,
            commands::create_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::create_query,
            commands::rename_query,
            commands::save_query,
            commands::save_draft,
            commands::move_query,
            commands::delete_query,
            commands::list_tabs,
            commands::open_tab,
            commands::activate_tab,
            commands::close_tab,
            commands::save_scratch,
            commands::set_cursor,
            commands::open_preview_tab,
            commands::promote_tab,
            commands::open_table_tab,
            commands::set_tab_mode,
            commands::write_text_file,
            commands::list_connections,
            commands::create_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::connect_saved,
            commands::refresh_schema
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
