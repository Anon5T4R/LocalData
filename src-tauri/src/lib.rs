mod db;
mod llm;
mod server;

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

/// Pasta de extensões do usuário (tipos de campo plugáveis em JS).
/// Criada na primeira consulta; fica no diretório de configuração do app.
fn extensions_dir_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("sem pasta de configuração: {}", e))?
        .join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("falha ao criar '{}': {}", dir.display(), e))?;
    Ok(dir)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionFile {
    file: String,
    source: String,
}

/// Lê os arquivos .js da pasta de extensões (ordem alfabética). O conteúdo é
/// avaliado NO FRONTEND — aqui o Rust só move bytes, como sempre.
#[tauri::command(async)]
fn extensions_list(app: tauri::AppHandle) -> Result<Vec<ExtensionFile>, String> {
    let dir = extensions_dir_path(&app)?;
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("falha ao ler '{}': {}", dir.display(), e))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("js")).unwrap_or(false))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for p in files {
        let source = std::fs::read_to_string(&p).map_err(|e| format!("falha ao ler '{}': {}", p.display(), e))?;
        let file = p.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        out.push(ExtensionFile { file, source });
    }
    Ok(out)
}

/// Caminho da pasta de extensões (a UI abre no gerenciador de arquivos).
#[tauri::command(async)]
fn extensions_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(extensions_dir_path(&app)?.to_string_lossy().to_string())
}

/// Grava um arquivo de extensão se ainda não existir (usado pra instalar o
/// exemplo na primeira execução — nunca sobrescreve o que o usuário editou).
#[tauri::command(async)]
fn extensions_install_default(app: tauri::AppHandle, file: String, source: String) -> Result<bool, String> {
    if file.contains('/') || file.contains('\\') || !file.ends_with(".js") {
        return Err("nome de arquivo de extensão inválido".into());
    }
    let dir = extensions_dir_path(&app)?;
    let dest = dir.join(&file);
    if dest.exists() {
        return Ok(false);
    }
    std::fs::write(&dest, source).map_err(|e| format!("falha ao gravar '{}': {}", dest.display(), e))?;
    Ok(true)
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
        .plugin(tauri_plugin_notification::init())
        .manage(db::Db::default())
        .manage(server::ServerState::default())
        .manage(Mutex::new(llm::LlmState::default()))
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            read_file_base64,
            write_file_base64,
            extensions_list,
            extensions_dir,
            extensions_install_default,
            db::backups_dir,
            db::base_create,
            db::base_open,
            db::base_close,
            db::base_schema,
            db::changes_since,
            db::records_aggregate,
            db::audit_query,
            db::users_list,
            db::user_save,
            db::user_delete,
            db::user_set_perm,
            db::automations_list,
            db::automation_save,
            db::automation_delete,
            db::attachment_upload,
            server::server_start,
            server::server_stop,
            server::server_status,
            db::table_create,
            db::table_rename,
            db::table_delete,
            db::table_duplicate,
            db::tables_reorder,
            db::field_create,
            db::field_update,
            db::field_change_type,
            db::field_delete,
            db::field_duplicate,
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
            db::view_duplicate,
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
