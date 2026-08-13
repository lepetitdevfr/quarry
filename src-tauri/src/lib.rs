pub mod conn;
pub mod error;
pub mod exec;
pub mod secrets;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

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
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
