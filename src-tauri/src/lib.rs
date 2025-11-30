// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // --- PLUGINS MUST BE REGISTERED HERE ---
        .plugin(tauri_plugin_shell::init())   // <--- Required for opening links in browser
        .plugin(tauri_plugin_http::init())    // <--- Required for fetching Slack/Asana data
        .plugin(tauri_plugin_opener::init())  // <--- Standard Tauri file opener
        // ---------------------------------------
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
