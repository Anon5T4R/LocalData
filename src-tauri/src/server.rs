//! Modo servidor: expõe a base ABERTA na GUI pra rede local (multiusuário).
//!
//! Desenho:
//! - HTTP síncrono (tiny_http), threads de trabalho; cada requisição vira uma
//!   chamada aos MESMOS comandos do db.rs (via `AppHandle::state`), então todo
//!   acesso serializa no mesmo Mutex — o SQLite nunca vê escrita concorrente.
//! - Autenticação por usuário/senha (_taylor_users, argon2) → token de sessão
//!   em memória. Papéis: leitor < editor < admin; override por tabela
//!   (_taylor_perms) vale pros comandos de registro.
//! - O servidor injeta `actor` nos argumentos das mutações — a auditoria
//!   registra QUEM fez, e o cliente não consegue se passar por outro.
//! - CORS liberado (o cliente é o próprio LocalData noutra máquina; o webview
//!   faz fetch cross-origin pro IP do host).

use crate::db::{self, Db};
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tiny_http::{Header, Method, Response, Server};

#[derive(Clone)]
struct Session {
    user_id: String,
    name: String,
    role: String,
}

pub struct ServerState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    port: u16,
    server: Arc<Server>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl Default for ServerState {
    fn default() -> Self {
        ServerState { inner: Mutex::new(None) }
    }
}

fn cors(mut resp: Response<std::io::Cursor<Vec<u8>>>) -> Response<std::io::Cursor<Vec<u8>>> {
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
        ("Content-Type", "application/json; charset=utf-8"),
    ] {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            resp.add_header(h);
        }
    }
    resp
}

fn reply(code: u16, body: Json) -> Response<std::io::Cursor<Vec<u8>>> {
    cors(Response::from_string(body.to_string()).with_status_code(code))
}

fn ok_json(result: Json) -> Response<std::io::Cursor<Vec<u8>>> {
    reply(200, json!({ "ok": true, "result": result }))
}

fn err_json(code: u16, msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    reply(code, json!({ "ok": false, "error": msg }))
}

/// Parâmetro obrigatório do corpo JSON.
fn req_arg<T: serde::de::DeserializeOwned>(args: &Json, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Json::Null))
        .map_err(|e| format!("parâmetro '{}' inválido: {}", key, e))
}

/// Parâmetro opcional (ausente/null → None).
fn opt_arg<T: serde::de::DeserializeOwned>(args: &Json, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("parâmetro '{}' inválido: {}", key, e)),
    }
}

fn to_json<T: serde::Serialize>(r: Result<T, String>) -> Result<Json, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Nível exigido por comando. `TableEdit`/`TableRead` conferem o override por
/// tabela (o table_id vem dos argumentos).
enum Need {
    Read,
    TableRead,
    TableEdit,
    Editor,
    Admin,
}

fn need_of(cmd: &str) -> Option<Need> {
    Some(match cmd {
        "base_schema" | "changes_since" | "attachment_read" | "attachment_metas" | "automations_list" => Need::Read,
        "records_query" | "records_by_ids" | "records_aggregate" => Need::TableRead,
        "record_create" | "records_update" | "records_delete" | "records_insert_bulk" | "records_restore" => {
            Need::TableEdit
        }
        "view_create" | "view_update" | "view_duplicate" | "view_delete" | "attachment_upload" | "audit_query" => {
            Need::Editor
        }
        "table_create" | "table_rename" | "table_delete" | "table_duplicate" | "tables_reorder" | "field_create"
        | "field_update" | "field_change_type" | "field_delete" | "field_duplicate" | "fields_reorder"
        | "users_list" | "user_save" | "user_delete" | "user_set_perm" | "automation_save" | "automation_delete"
        | "attachments_gc" => Need::Admin,
        _ => return None,
    })
}

fn role_rank(role: &str) -> u8 {
    match role {
        "admin" => 3,
        "editor" => 2,
        _ => 1,
    }
}

/// Executa um comando em nome de um usuário autenticado.
fn dispatch(app: &tauri::AppHandle, sess: &Session, cmd: &str, mut args: Json) -> Result<Json, String> {
    let db_state = app.state::<Db>();
    let db: &Db = &db_state;

    let need = need_of(cmd).ok_or_else(|| format!("comando não disponível remotamente: '{}'", cmd))?;
    match need {
        Need::Read => {}
        Need::Editor => {
            if role_rank(&sess.role) < 2 {
                return Err("permissão insuficiente (precisa ser editor)".into());
            }
        }
        Need::Admin => {
            if role_rank(&sess.role) < 3 {
                return Err("permissão insuficiente (precisa ser admin)".into());
            }
        }
        Need::TableRead | Need::TableEdit => {
            let table_id: String = req_arg(&args, "tableId")?;
            let level = db::table_level(db, &sess.user_id, &sess.role, &table_id)?;
            let needs_edit = matches!(need, Need::TableEdit);
            if level == "none" || (needs_edit && level != "edit") {
                return Err("sem permissão nesta tabela".into());
            }
        }
    }

    // o servidor é a autoridade sobre QUEM está agindo
    if let Some(map) = args.as_object_mut() {
        map.insert("actor".into(), json!(sess.name));
    }

    match cmd {
        "base_schema" => to_json(db::base_schema(app.state())),
        "changes_since" => to_json(db::changes_since(app.state(), req_arg(&args, "since")?)),
        "records_query" => to_json(db::records_query(
            app.state(),
            req_arg(&args, "tableId")?,
            opt_arg(&args, "filters")?,
            opt_arg(&args, "sorts")?,
            opt_arg(&args, "search")?,
            opt_arg(&args, "limit")?,
            opt_arg(&args, "offset")?,
        )),
        "records_by_ids" => to_json(db::records_by_ids(app.state(), req_arg(&args, "tableId")?, req_arg(&args, "ids")?)),
        "records_aggregate" => to_json(db::records_aggregate(
            app.state(),
            req_arg(&args, "tableId")?,
            opt_arg(&args, "filters")?,
            opt_arg(&args, "search")?,
            req_arg(&args, "aggs")?,
        )),
        "record_create" => to_json(db::record_create(
            app.state(),
            req_arg(&args, "tableId")?,
            args.get("cells").cloned().unwrap_or(json!({})),
            Some(sess.name.clone()),
        )),
        "records_update" => to_json(db::records_update(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "updates")?,
            Some(sess.name.clone()),
        )),
        "records_delete" => to_json(db::records_delete(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "ids")?,
            Some(sess.name.clone()),
        )),
        "records_insert_bulk" => to_json(db::records_insert_bulk(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "rows")?,
            Some(sess.name.clone()),
        )),
        "records_restore" => to_json(db::records_restore(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "rows")?,
            Some(sess.name.clone()),
        )),
        "audit_query" => to_json(db::audit_query(
            app.state(),
            opt_arg(&args, "tableId")?,
            opt_arg(&args, "recordId")?,
            opt_arg(&args, "limit")?,
            opt_arg(&args, "offset")?,
        )),
        "table_create" => to_json(db::table_create(app.state(), req_arg(&args, "name")?, Some(sess.name.clone()))),
        "table_rename" => to_json(db::table_rename(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "name")?,
            Some(sess.name.clone()),
        )),
        "table_delete" => to_json(db::table_delete(app.state(), req_arg(&args, "tableId")?, Some(sess.name.clone()))),
        "table_duplicate" => to_json(db::table_duplicate(app.state(), req_arg(&args, "tableId")?, Some(sess.name.clone()))),
        "tables_reorder" => to_json(db::tables_reorder(app.state(), req_arg(&args, "ids")?)),
        "field_create" => to_json(db::field_create(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "name")?,
            req_arg(&args, "fieldType")?,
            args.get("options").cloned().unwrap_or(json!({})),
            Some(sess.name.clone()),
        )),
        "field_update" => to_json(db::field_update(
            app.state(),
            req_arg(&args, "fieldId")?,
            opt_arg(&args, "name")?,
            opt_arg(&args, "options")?,
        )),
        "field_change_type" => to_json(db::field_change_type(
            app.state(),
            req_arg(&args, "fieldId")?,
            req_arg(&args, "fieldType")?,
            opt_arg(&args, "options")?,
            Some(sess.name.clone()),
        )),
        "field_delete" => to_json(db::field_delete(app.state(), req_arg(&args, "fieldId")?, Some(sess.name.clone()))),
        "field_duplicate" => to_json(db::field_duplicate(app.state(), req_arg(&args, "fieldId")?)),
        "fields_reorder" => to_json(db::fields_reorder(app.state(), req_arg(&args, "tableId")?, req_arg(&args, "ids")?)),
        "view_create" => to_json(db::view_create(
            app.state(),
            req_arg(&args, "tableId")?,
            req_arg(&args, "name")?,
            req_arg(&args, "kind")?,
            args.get("config").cloned().unwrap_or(json!({})),
        )),
        "view_update" => to_json(db::view_update(
            app.state(),
            req_arg(&args, "viewId")?,
            opt_arg(&args, "name")?,
            opt_arg(&args, "config")?,
        )),
        "view_duplicate" => to_json(db::view_duplicate(app.state(), req_arg(&args, "viewId")?)),
        "view_delete" => to_json(db::view_delete(app.state(), req_arg(&args, "viewId")?)),
        "attachment_upload" => to_json(db::attachment_upload(
            app.state(),
            req_arg(&args, "name")?,
            req_arg(&args, "base64Data")?,
        )),
        "attachment_read" => to_json(db::attachment_read(app.state(), req_arg(&args, "id")?)),
        "attachment_metas" => to_json(db::attachment_metas(app.state(), req_arg(&args, "ids")?)),
        "attachments_gc" => to_json(db::attachments_gc(app.state())),
        "automations_list" => to_json(db::automations_list(app.state(), opt_arg(&args, "tableId")?)),
        "automation_save" => to_json(db::automation_save(
            app.state(),
            opt_arg(&args, "id")?,
            req_arg(&args, "tableId")?,
            args.get("config").cloned().unwrap_or(json!({})),
            Some(sess.name.clone()),
        )),
        "automation_delete" => to_json(db::automation_delete(app.state(), req_arg(&args, "id")?, Some(sess.name.clone()))),
        "users_list" => to_json(db::users_list(app.state())),
        "user_save" => to_json(db::user_save(
            app.state(),
            opt_arg(&args, "id")?,
            req_arg(&args, "name")?,
            req_arg(&args, "role")?,
            opt_arg(&args, "password")?,
            Some(sess.name.clone()),
        )),
        "user_delete" => to_json(db::user_delete(app.state(), req_arg(&args, "userId")?, Some(sess.name.clone()))),
        "user_set_perm" => to_json(db::user_set_perm(
            app.state(),
            req_arg(&args, "userId")?,
            req_arg(&args, "tableId")?,
            req_arg(&args, "level")?,
        )),
        other => Err(format!("comando não disponível remotamente: '{}'", other)),
    }
}

fn new_token(db: &Db) -> Result<String, String> {
    db::with_base(db, |b| {
        b.conn
            .query_row("SELECT lower(hex(randomblob(32)))", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    })
}

fn handle_request(app: &tauri::AppHandle, sessions: &Arc<Mutex<HashMap<String, Session>>>, mut rq: tiny_http::Request) {
    let method = rq.method().clone();
    let url = rq.url().to_string();

    if method == Method::Options {
        let _ = rq.respond(reply(204, json!({})));
        return;
    }

    if method == Method::Get && url == "/api/ping" {
        let db_state = app.state::<Db>();
        let base_name = db::base_schema(app.state()).map(|s| s.name).unwrap_or_default();
        let _ = db_state; // (estado usado só via base_schema)
        let _ = rq.respond(ok_json(json!({
            "app": "LocalData",
            "version": env!("CARGO_PKG_VERSION"),
            "base": base_name,
        })));
        return;
    }

    // corpo JSON (limite defensivo de 64MB — anexos vão em base64)
    let mut body = String::new();
    if rq.as_reader().take(64 * 1024 * 1024).read_to_string(&mut body).is_err() {
        let _ = rq.respond(err_json(400, "corpo inválido"));
        return;
    }
    let args: Json = if body.trim().is_empty() { json!({}) } else { serde_json::from_str(&body).unwrap_or(json!({})) };

    if method == Method::Post && url == "/api/login" {
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let password = args.get("password").and_then(|v| v.as_str()).unwrap_or("");
        let db_state = app.state::<Db>();
        match db::verify_login(&db_state, name, password) {
            Ok((user_id, name, role)) => match new_token(&db_state) {
                Ok(token) => {
                    sessions
                        .lock()
                        .unwrap()
                        .insert(token.clone(), Session { user_id, name: name.clone(), role: role.clone() });
                    let _ = rq.respond(ok_json(json!({ "token": token, "name": name, "role": role })));
                }
                Err(e) => {
                    let _ = rq.respond(err_json(500, &e));
                }
            },
            Err(e) => {
                let _ = rq.respond(err_json(401, &e));
            }
        }
        return;
    }

    // daqui pra baixo: precisa de sessão
    let token = rq
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
        .map(|h| h.value.as_str().trim_start_matches("Bearer ").to_string())
        .unwrap_or_default();
    let sess = sessions.lock().unwrap().get(&token).cloned();
    let Some(sess) = sess else {
        let _ = rq.respond(err_json(401, "sessão inválida — faça login de novo"));
        return;
    };

    if method == Method::Post && url == "/api/logout" {
        sessions.lock().unwrap().remove(&token);
        let _ = rq.respond(ok_json(json!({})));
        return;
    }

    if method == Method::Post {
        if let Some(cmd) = url.strip_prefix("/api/cmd/") {
            let cmd = cmd.to_string();
            let resp = match dispatch(app, &sess, &cmd, args) {
                Ok(result) => ok_json(result),
                Err(e) => err_json(400, &e),
            };
            let _ = rq.respond(resp);
            return;
        }
    }

    let _ = rq.respond(err_json(404, "rota desconhecida"));
}

/// IP provável desta máquina na LAN (dica pra UI; sem tráfego real).
fn lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.168.255.255:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "?".into())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub lan_ip: String,
}

#[tauri::command(async)]
pub fn server_start(app: tauri::AppHandle, state: tauri::State<'_, ServerState>, port: u16) -> Result<ServerStatus, String> {
    let mut guard = state.inner.lock().map_err(|_| "estado do servidor corrompido")?;
    if guard.is_some() {
        return Err("o servidor já está rodando".into());
    }
    // precisa de base aberta e de pelo menos um admin cadastrado
    {
        let db = app.state::<Db>();
        db::with_base(&db, |b| {
            let admins: i64 = b
                .conn
                .query_row("SELECT COUNT(*) FROM _taylor_users WHERE role = 'admin'", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if admins == 0 {
                return Err("cadastre pelo menos um usuário admin antes de servir (menu 🌐 → Usuários)".into());
            }
            Ok(())
        })?;
    }
    let server = Server::http(("0.0.0.0", port)).map_err(|e| format!("falha ao abrir a porta {}: {}", port, e))?;
    let server = Arc::new(server);
    let sessions: Arc<Mutex<HashMap<String, Session>>> = Arc::new(Mutex::new(HashMap::new()));
    for _ in 0..4 {
        let server = server.clone();
        let sessions = sessions.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            while let Ok(rq) = server.recv() {
                handle_request(&app, &sessions, rq);
            }
        });
    }
    *guard = Some(Running { port, server, sessions });
    Ok(ServerStatus { running: true, port, lan_ip: lan_ip() })
}

#[tauri::command(async)]
pub fn server_stop(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "estado do servidor corrompido")?;
    if let Some(running) = guard.take() {
        running.server.unblock();
        running.sessions.lock().map(|mut s| s.clear()).ok();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn server_status(state: tauri::State<'_, ServerState>) -> Result<ServerStatus, String> {
    let guard = state.inner.lock().map_err(|_| "estado do servidor corrompido")?;
    Ok(match guard.as_ref() {
        Some(r) => ServerStatus { running: true, port: r.port, lan_ip: lan_ip() },
        None => ServerStatus { running: false, port: 0, lan_ip: lan_ip() },
    })
}
