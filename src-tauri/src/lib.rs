mod db;
mod llm;

use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// File path passed at launch (e.g. when opening a `.tbase` with the app), if any.
#[tauri::command(async)]
fn get_startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

/// Read any file as base64 (import CSV/XLSX: o parse fica no webview, Rust só move bytes).
#[tauri::command(async)]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| format!("Falha ao ler '{}': {}", path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Write a base64 payload to disk as binary (export XLSX/CSV).
#[tauri::command(async)]
fn write_file_base64(path: String, base64_data: String) -> Result<(), String> {
    use base64::Engine;
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Falha ao criar diretório '{}': {}", parent.display(), e))?;
        }
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 inválido: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Falha ao salvar '{}': {}", path, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be registered first: a 2nd launch (e.g. "open with")
        // forwards the file path to the running window instead of starting a new app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(file) = argv.iter().skip(1).find(|a| Path::new(a).is_file()) {
                let _ = app.emit("open-file", file.clone());
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db::Db::default())
        .manage(Mutex::new(llm::LlmState::default()))
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            read_file_base64,
            write_file_base64,
            db::base_create,
            db::base_open,
            db::base_close,
            db::base_schema,
            db::table_create,
            db::table_rename,
            db::table_delete,
            db::tables_reorder,
            db::field_create,
            db::field_update,
            db::field_change_type,
            db::field_delete,
            db::fields_reorder,
            db::records_query,
            db::records_by_ids,
            db::record_create,
            db::records_update,
            db::records_delete,
            db::records_insert_bulk,
            db::records_restore,
            db::view_create,
            db::view_update,
            db::view_delete,
            db::attachment_import,
            db::attachment_read,
            db::attachment_metas,
            db::attachments_gc,
            llm::list_models,
            llm::start_llm,
            llm::stop_llm,
            llm::llm_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Ensure the llama-server child is killed when the app exits.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Mutex<llm::LlmState>>() {
                    if let Ok(mut s) = state.lock() {
                        if let Some(child) = s.child.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
