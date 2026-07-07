//! Núcleo do LocalData: uma "base" é um arquivo SQLite (`.tbase`).
//!
//! O arquivo é um banco SQLite comum e legítimo — abre em qualquer ferramenta
//! SQLite. O LocalData guarda o schema "rico" (tipos de campo, opções, views)
//! em tabelas de metadados `_taylor_*`, e os registros em tabelas reais:
//!
//! - tabela de dados:  `t_<id>`  (uma por tabela do usuário)
//! - coluna de campo:  `c_<id>`  (nome de exibição fica em `_taylor_fields`)
//!
//! IDs estáveis nos identificadores SQL = renomear tabela/campo nunca gera DDL.
//!
//! Regra de ouro (vale também pra IA): **nenhum SQL cru vem de fora**. Todos os
//! comandos recebem JSON tipado, validam contra o schema e executam queries
//! parametrizadas construídas aqui.

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct Base {
    pub conn: Connection,
    pub path: PathBuf,
}

#[derive(Default)]
pub struct Db(pub Mutex<Option<Base>>);

const SCHEMA_VERSION: i64 = 1;

/// Tipos de campo suportados. "formula" é computado no frontend e não tem coluna.
pub const FIELD_TYPES: &[&str] = &[
    "text",
    "long_text",
    "number",
    "checkbox",
    "date",
    "select",
    "multi_select",
    "link",
    "attachment",
    "formula",
];

fn has_column(ftype: &str) -> bool {
    ftype != "formula"
}

/// ID curto, estável e seguro para identificador SQL (hex + contador).
fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0);
    let c = N.fetch_add(1, Ordering::Relaxed) as u64;
    format!("{:x}{:02x}", t & 0xffff_ffff_ffff, c & 0xff)
}

fn err<T>(msg: impl Into<String>) -> Result<T, String> {
    Err(msg.into())
}

fn db_err(e: rusqlite::Error) -> String {
    format!("erro no banco: {}", e)
}

// ---------------------------------------------------------------------------
// Schema (metadados) — o que o frontend enxerga
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FieldMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub ftype: String,
    pub options: Json,
    pub pos: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ViewMeta {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub config: Json,
    pub pos: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub id: String,
    pub name: String,
    pub pos: i64,
    pub fields: Vec<FieldMeta>,
    pub views: Vec<ViewMeta>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BaseSchema {
    pub path: String,
    pub name: String,
    pub tables: Vec<TableMeta>,
}

fn init_meta(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _taylor_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS _taylor_tables(
            id TEXT PRIMARY KEY, name TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS _taylor_fields(
            id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL,
            type TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}', pos INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS _taylor_views(
            id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL,
            kind TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', pos INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS _taylor_blobs(
            id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
            size INTEGER NOT NULL, data BLOB NOT NULL);",
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO _taylor_meta(key, value) VALUES ('app', 'LocalData'), ('schema_version', ?1)",
        [SCHEMA_VERSION.to_string()],
    )
    .map_err(db_err)?;
    Ok(())
}

fn read_schema(conn: &Connection, path: &PathBuf) -> Result<BaseSchema, String> {
    let mut tables: Vec<TableMeta> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, pos FROM _taylor_tables ORDER BY pos, rowid")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TableMeta {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    pos: r.get(2)?,
                    fields: Vec::new(),
                    views: Vec::new(),
                })
            })
            .map_err(db_err)?;
        for t in rows {
            tables.push(t.map_err(db_err)?);
        }
    }
    for t in tables.iter_mut() {
        let mut stmt = conn
            .prepare("SELECT id, name, type, options, pos FROM _taylor_fields WHERE table_id = ?1 ORDER BY pos, rowid")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([&t.id], |r| {
                let opts: String = r.get(3)?;
                Ok(FieldMeta {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    ftype: r.get(2)?,
                    options: serde_json::from_str(&opts).unwrap_or(json!({})),
                    pos: r.get(4)?,
                })
            })
            .map_err(db_err)?;
        for f in rows {
            t.fields.push(f.map_err(db_err)?);
        }
        let mut stmt = conn
            .prepare("SELECT id, name, kind, config, pos FROM _taylor_views WHERE table_id = ?1 ORDER BY pos, rowid")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([&t.id], |r| {
                let cfg: String = r.get(3)?;
                Ok(ViewMeta {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    config: serde_json::from_str(&cfg).unwrap_or(json!({})),
                    pos: r.get(4)?,
                })
            })
            .map_err(db_err)?;
        for v in rows {
            t.views.push(v.map_err(db_err)?);
        }
    }
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Base")
        .to_string();
    Ok(BaseSchema { path: path.to_string_lossy().to_string(), name, tables })
}

fn field_meta(conn: &Connection, field_id: &str) -> Result<(String, String, Json), String> {
    let row = conn
        .query_row(
            "SELECT table_id, type, options FROM _taylor_fields WHERE id = ?1",
            [field_id],
            |r| {
                let opts: String = r.get(2)?;
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, opts))
            },
        )
        .optional()
        .map_err(db_err)?;
    match row {
        Some((tid, ftype, opts)) => Ok((tid, ftype, serde_json::from_str(&opts).unwrap_or(json!({})))),
        None => err("campo não encontrado"),
    }
}

fn table_fields(conn: &Connection, table_id: &str) -> Result<Vec<FieldMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, type, options, pos FROM _taylor_fields WHERE table_id = ?1 ORDER BY pos, rowid")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([table_id], |r| {
            let opts: String = r.get(3)?;
            Ok(FieldMeta {
                id: r.get(0)?,
                name: r.get(1)?,
                ftype: r.get(2)?,
                options: serde_json::from_str(&opts).unwrap_or(json!({})),
                pos: r.get(4)?,
            })
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for f in rows {
        out.push(f.map_err(db_err)?);
    }
    Ok(out)
}

fn table_exists(conn: &Connection, table_id: &str) -> Result<(), String> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM _taylor_tables WHERE id = ?1", [table_id], |r| r.get(0))
        .map_err(db_err)?;
    if n == 0 {
        return err("tabela não encontrada");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Validação de célula: JSON de fora -> valor SQL tipado
// ---------------------------------------------------------------------------

/// Converte (e valida) o valor JSON de uma célula para o tipo SQL do campo.
/// Campos de coleção (multi_select/link/attachment) são armazenados como JSON
/// text — mas sempre re-serializados a partir da estrutura validada, nunca
/// texto cru de fora.
fn cell_to_sql(ftype: &str, options: &Json, v: &Json) -> Result<SqlValue, String> {
    if v.is_null() {
        return Ok(SqlValue::Null);
    }
    match ftype {
        "text" | "long_text" => match v {
            Json::String(s) => Ok(SqlValue::Text(s.clone())),
            Json::Number(n) => Ok(SqlValue::Text(n.to_string())),
            Json::Bool(b) => Ok(SqlValue::Text(b.to_string())),
            _ => err("texto inválido"),
        },
        "number" => match v {
            Json::Number(n) => Ok(SqlValue::Real(n.as_f64().unwrap_or(0.0))),
            Json::String(s) => {
                let s = s.trim().replace(',', ".");
                if s.is_empty() {
                    return Ok(SqlValue::Null);
                }
                s.parse::<f64>().map(SqlValue::Real).map_err(|_| format!("número inválido: '{}'", s))
            }
            _ => err("número inválido"),
        },
        "checkbox" => match v {
            Json::Bool(b) => Ok(SqlValue::Integer(*b as i64)),
            Json::Number(n) => Ok(SqlValue::Integer((n.as_f64().unwrap_or(0.0) != 0.0) as i64)),
            _ => err("checkbox inválido"),
        },
        "date" => match v {
            // ISO: "YYYY-MM-DD" ou "YYYY-MM-DDTHH:MM" — ordena certo como texto.
            Json::String(s) => {
                let s = s.trim();
                if s.is_empty() {
                    return Ok(SqlValue::Null);
                }
                let ok = s.len() >= 10
                    && s.as_bytes()[4] == b'-'
                    && s.as_bytes()[7] == b'-'
                    && s[..4].chars().all(|c| c.is_ascii_digit());
                if !ok {
                    return err(format!("data inválida (use ISO AAAA-MM-DD): '{}'", s));
                }
                Ok(SqlValue::Text(s.to_string()))
            }
            _ => err("data inválida"),
        },
        "select" => match v {
            Json::String(s) => {
                if s.is_empty() {
                    return Ok(SqlValue::Null);
                }
                if let Some(choices) = options.get("choices").and_then(|c| c.as_array()) {
                    if !choices.iter().any(|c| c.get("id").and_then(|i| i.as_str()) == Some(s.as_str())) {
                        return err(format!("opção desconhecida: '{}'", s));
                    }
                }
                Ok(SqlValue::Text(s.clone()))
            }
            _ => err("seleção inválida"),
        },
        "multi_select" => match v {
            Json::Array(items) => {
                let mut ids: Vec<String> = Vec::new();
                let choices = options.get("choices").and_then(|c| c.as_array());
                for it in items {
                    let s = it.as_str().ok_or("multi-seleção inválida")?;
                    if let Some(cs) = choices {
                        if !cs.iter().any(|c| c.get("id").and_then(|i| i.as_str()) == Some(s)) {
                            return err(format!("opção desconhecida: '{}'", s));
                        }
                    }
                    ids.push(s.to_string());
                }
                Ok(SqlValue::Text(serde_json::to_string(&ids).unwrap_or_default()))
            }
            _ => err("multi-seleção inválida (esperado array)"),
        },
        "link" => match v {
            Json::Array(items) => {
                let mut ids: Vec<i64> = Vec::new();
                for it in items {
                    ids.push(it.as_i64().ok_or("relação inválida (esperado ids numéricos)")?);
                }
                Ok(SqlValue::Text(serde_json::to_string(&ids).unwrap_or_default()))
            }
            _ => err("relação inválida (esperado array de ids)"),
        },
        "attachment" => match v {
            Json::Array(items) => {
                let mut ids: Vec<String> = Vec::new();
                for it in items {
                    ids.push(it.as_str().ok_or("anexo inválido")?.to_string());
                }
                Ok(SqlValue::Text(serde_json::to_string(&ids).unwrap_or_default()))
            }
            _ => err("anexo inválido (esperado array de ids)"),
        },
        "formula" => err("campo de fórmula é somente leitura"),
        other => err(format!("tipo de campo desconhecido: '{}'", other)),
    }
}

/// Converte o valor SQL armazenado de volta para JSON, conforme o tipo do campo.
fn sql_to_json(ftype: &str, v: rusqlite::types::ValueRef<'_>) -> Json {
    use rusqlite::types::ValueRef as VR;
    if matches!(v, VR::Null) {
        return Json::Null;
    }
    match ftype {
        "number" => match v {
            VR::Real(f) => json!(f),
            VR::Integer(i) => json!(i),
            VR::Text(t) => String::from_utf8_lossy(t).parse::<f64>().map(|f| json!(f)).unwrap_or(Json::Null),
            _ => Json::Null,
        },
        "checkbox" => match v {
            VR::Integer(i) => json!(i != 0),
            _ => json!(false),
        },
        "multi_select" | "link" | "attachment" => match v {
            VR::Text(t) => serde_json::from_slice::<Json>(t).unwrap_or(json!([])),
            _ => json!([]),
        },
        _ => match v {
            VR::Text(t) => json!(String::from_utf8_lossy(t)),
            VR::Integer(i) => json!(i.to_string()),
            VR::Real(f) => json!(f.to_string()),
            _ => Json::Null,
        },
    }
}

// ---------------------------------------------------------------------------
// Filtros e ordenação (parametrizados)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub field_id: String,
    pub op: String,
    #[serde(default)]
    pub value: Json,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub field_id: String,
    #[serde(default)]
    pub desc: bool,
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Monta o WHERE de um filtro. Retorna (sql, params).
fn filter_sql(f: &Filter, fields: &[FieldMeta]) -> Result<(String, Vec<SqlValue>), String> {
    let meta = fields
        .iter()
        .find(|m| m.id == f.field_id)
        .ok_or("filtro aponta pra campo inexistente")?;
    if !has_column(&meta.ftype) {
        return err("não é possível filtrar por campo de fórmula");
    }
    let col = format!("\"c_{}\"", meta.id);
    let vstr = f.value.as_str().map(|s| s.to_string()).unwrap_or_else(|| {
        if f.value.is_null() { String::new() } else { f.value.to_string().trim_matches('"').to_string() }
    });
    let vnum = match &f.value {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.trim().replace(',', ".").parse::<f64>().ok(),
        _ => None,
    };
    match f.op.as_str() {
        "eq" => {
            if meta.ftype == "number" {
                let n = vnum.ok_or("valor numérico inválido no filtro")?;
                Ok((format!("CAST({} AS REAL) = ?", col), vec![SqlValue::Real(n)]))
            } else {
                Ok((format!("{} = ?", col), vec![SqlValue::Text(vstr)]))
            }
        }
        "neq" => {
            if meta.ftype == "number" {
                let n = vnum.ok_or("valor numérico inválido no filtro")?;
                Ok((format!("({0} IS NULL OR CAST({0} AS REAL) != ?)", col), vec![SqlValue::Real(n)]))
            } else {
                Ok((format!("({0} IS NULL OR {0} != ?)", col), vec![SqlValue::Text(vstr)]))
            }
        }
        "contains" => Ok((
            format!("{} LIKE ? ESCAPE '\\'", col),
            vec![SqlValue::Text(format!("%{}%", like_escape(&vstr)))],
        )),
        "not_contains" => Ok((
            format!("({0} IS NULL OR {0} NOT LIKE ? ESCAPE '\\')", col),
            vec![SqlValue::Text(format!("%{}%", like_escape(&vstr)))],
        )),
        "empty" => Ok((format!("({0} IS NULL OR {0} = '' OR {0} = '[]')", col), vec![])),
        "not_empty" => Ok((format!("({0} IS NOT NULL AND {0} != '' AND {0} != '[]')", col), vec![])),
        "gt" | "gte" | "lt" | "lte" => {
            let sym = match f.op.as_str() {
                "gt" => ">",
                "gte" => ">=",
                "lt" => "<",
                _ => "<=",
            };
            if meta.ftype == "number" {
                let n = vnum.ok_or("valor numérico inválido no filtro")?;
                Ok((format!("CAST({} AS REAL) {} ?", col, sym), vec![SqlValue::Real(n)]))
            } else {
                // datas ISO ordenam lexicograficamente
                Ok((format!("{} {} ?", col, sym), vec![SqlValue::Text(vstr)]))
            }
        }
        "checked" => Ok((format!("{} = 1", col), vec![])),
        "unchecked" => Ok((format!("({0} IS NULL OR {0} = 0)", col), vec![])),
        // multi_select/link: o valor armazenado é JSON text — procurar o elemento citado
        "has" => Ok((
            format!("{} LIKE ? ESCAPE '\\'", col),
            vec![SqlValue::Text(format!("%\"{}\"%", like_escape(&vstr)))],
        )),
        "has_record" => {
            let id = f.value.as_i64().ok_or("id de registro inválido no filtro")?;
            // ids numéricos num array JSON: [7] / [7,8] / [6,7]
            Ok((
                format!("({0} LIKE ? OR {0} LIKE ? OR {0} LIKE ? OR {0} = ?)", col),
                vec![
                    SqlValue::Text(format!("[{},%", id)),
                    SqlValue::Text(format!("%,{},%", id)),
                    SqlValue::Text(format!("%,{}]", id)),
                    SqlValue::Text(format!("[{}]", id)),
                ],
            ))
        }
        other => err(format!("operador de filtro desconhecido: '{}'", other)),
    }
}

fn build_where(
    filters: &[Filter],
    search: &Option<String>,
    fields: &[FieldMeta],
) -> Result<(String, Vec<SqlValue>), String> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    for f in filters {
        let (sql, mut p) = filter_sql(f, fields)?;
        clauses.push(sql);
        params.append(&mut p);
    }
    if let Some(q) = search {
        let q = q.trim();
        if !q.is_empty() {
            let mut ors: Vec<String> = Vec::new();
            for m in fields {
                if matches!(m.ftype.as_str(), "text" | "long_text" | "date") {
                    ors.push(format!("\"c_{}\" LIKE ? ESCAPE '\\'", m.id));
                    params.push(SqlValue::Text(format!("%{}%", like_escape(q))));
                } else if m.ftype == "number" {
                    ors.push(format!("CAST(\"c_{}\" AS TEXT) LIKE ?", m.id));
                    params.push(SqlValue::Text(format!("%{}%", q)));
                }
            }
            if !ors.is_empty() {
                clauses.push(format!("({})", ors.join(" OR ")));
            }
        }
    }
    if clauses.is_empty() {
        Ok((String::new(), params))
    } else {
        Ok((format!(" WHERE {}", clauses.join(" AND ")), params))
    }
}

fn build_order(sorts: &[Sort], fields: &[FieldMeta]) -> Result<String, String> {
    if sorts.is_empty() {
        return Ok(" ORDER BY id".into());
    }
    let mut parts: Vec<String> = Vec::new();
    for s in sorts {
        let meta = fields
            .iter()
            .find(|m| m.id == s.field_id)
            .ok_or("ordenação aponta pra campo inexistente")?;
        if !has_column(&meta.ftype) {
            return err("não é possível ordenar por campo de fórmula");
        }
        let col = format!("\"c_{}\"", meta.id);
        let dir = if s.desc { "DESC" } else { "ASC" };
        let expr = match meta.ftype.as_str() {
            "number" => format!("CAST({} AS REAL) {}", col, dir),
            "text" | "long_text" | "select" => format!("{} COLLATE NOCASE {}", col, dir),
            _ => format!("{} {}", col, dir),
        };
        parts.push(expr);
    }
    parts.push("id".into());
    Ok(format!(" ORDER BY {}", parts.join(", ")))
}

// ---------------------------------------------------------------------------
// Helpers de estado
// ---------------------------------------------------------------------------

fn with_base<T>(state: &State<'_, Db>, f: impl FnOnce(&mut Base) -> Result<T, String>) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "estado do banco corrompido")?;
    match guard.as_mut() {
        Some(base) => f(base),
        None => err("nenhuma base aberta"),
    }
}

fn create_default_table(conn: &Connection, name: &str) -> Result<String, String> {
    let tid = new_id();
    let pos: i64 = conn
        .query_row("SELECT COALESCE(MAX(pos), -1) + 1 FROM _taylor_tables", [], |r| r.get(0))
        .map_err(db_err)?;
    conn.execute(
        "INSERT INTO _taylor_tables(id, name, pos) VALUES (?1, ?2, ?3)",
        rusqlite::params![tid, name, pos],
    )
    .map_err(db_err)?;
    let f1 = new_id();
    let f2 = new_id();
    conn.execute(
        "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES
         (?1, ?2, 'Nome', 'text', '{}', 0), (?3, ?2, 'Notas', 'long_text', '{}', 1)",
        rusqlite::params![f1, tid, f2],
    )
    .map_err(db_err)?;
    conn.execute(
        &format!(
            "CREATE TABLE \"t_{}\" (id INTEGER PRIMARY KEY AUTOINCREMENT, \"c_{}\", \"c_{}\")",
            tid, f1, f2
        ),
        [],
    )
    .map_err(db_err)?;
    let vid = new_id();
    conn.execute(
        "INSERT INTO _taylor_views(id, table_id, name, kind, config, pos) VALUES (?1, ?2, 'Grade', 'grid', '{}', 0)",
        rusqlite::params![vid, tid],
    )
    .map_err(db_err)?;
    Ok(tid)
}

fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("falha ao abrir '{}': {}", path.display(), e))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(db_err)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Comandos: base
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn base_create(state: State<'_, Db>, path: String) -> Result<BaseSchema, String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return err(format!("já existe um arquivo em '{}'", path));
    }
    let conn = open_connection(&p)?;
    init_meta(&conn)?;
    create_default_table(&conn, "Tabela 1")?;
    let schema = read_schema(&conn, &p)?;
    let mut guard = state.0.lock().map_err(|_| "estado do banco corrompido")?;
    *guard = Some(Base { conn, path: p });
    Ok(schema)
}

#[tauri::command]
pub fn base_open(state: State<'_, Db>, path: String) -> Result<BaseSchema, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return err(format!("arquivo não encontrado: '{}'", path));
    }
    let conn = open_connection(&p)?;
    // Base nova pro LocalData? Valida/instala os metadados (permite abrir um
    // SQLite alheio — ele vira uma base com as tabelas dele intocadas; só as
    // _taylor_* são adicionadas).
    let is_ours: Option<String> = conn
        .query_row("SELECT value FROM _taylor_meta WHERE key = 'app'", [], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    if is_ours.is_none() {
        init_meta(&conn)?;
    }
    let version: i64 = conn
        .query_row("SELECT value FROM _taylor_meta WHERE key = 'schema_version'", [], |r| {
            r.get::<_, String>(0)
        })
        .map(|v| v.parse().unwrap_or(0))
        .unwrap_or(0);
    if version > SCHEMA_VERSION {
        return err("esta base foi criada por uma versão mais nova do LocalData");
    }
    // migrações futuras: while version < SCHEMA_VERSION { ... }
    let schema = read_schema(&conn, &p)?;
    let mut guard = state.0.lock().map_err(|_| "estado do banco corrompido")?;
    *guard = Some(Base { conn, path: p });
    Ok(schema)
}

#[tauri::command]
pub fn base_close(state: State<'_, Db>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "estado do banco corrompido")?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn base_schema(state: State<'_, Db>) -> Result<BaseSchema, String> {
    with_base(&state, |b| read_schema(&b.conn, &b.path))
}

// ---------------------------------------------------------------------------
// Comandos: tabelas
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn table_create(state: State<'_, Db>, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de tabela vazio");
    }
    with_base(&state, |b| {
        let tx = b.conn.transaction().map_err(db_err)?;
        let tid = create_default_table(&tx, &name)?;
        tx.commit().map_err(db_err)?;
        Ok(tid)
    })
}

#[tauri::command]
pub fn table_rename(state: State<'_, Db>, table_id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de tabela vazio");
    }
    with_base(&state, |b| {
        let n = b
            .conn
            .execute("UPDATE _taylor_tables SET name = ?1 WHERE id = ?2", rusqlite::params![name, table_id])
            .map_err(db_err)?;
        if n == 0 {
            return err("tabela não encontrada");
        }
        Ok(())
    })
}

#[tauri::command]
pub fn table_delete(state: State<'_, Db>, table_id: String) -> Result<(), String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        tx.execute(&format!("DROP TABLE IF EXISTS \"t_{}\"", table_id), []).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_fields WHERE table_id = ?1", [&table_id]).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_views WHERE table_id = ?1", [&table_id]).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_tables WHERE id = ?1", [&table_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    })
}

#[tauri::command]
pub fn tables_reorder(state: State<'_, Db>, ids: Vec<String>) -> Result<(), String> {
    with_base(&state, |b| {
        let tx = b.conn.transaction().map_err(db_err)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE _taylor_tables SET pos = ?1 WHERE id = ?2", rusqlite::params![i as i64, id])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Comandos: campos
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn field_create(
    state: State<'_, Db>,
    table_id: String,
    name: String,
    field_type: String,
    options: Json,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de campo vazio");
    }
    if !FIELD_TYPES.contains(&field_type.as_str()) {
        return err(format!("tipo de campo desconhecido: '{}'", field_type));
    }
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fid = new_id();
        let pos: i64 = b
            .conn
            .query_row(
                "SELECT COALESCE(MAX(pos), -1) + 1 FROM _taylor_fields WHERE table_id = ?1",
                [&table_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        tx.execute(
            "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![fid, table_id, name, field_type, options.to_string(), pos],
        )
        .map_err(db_err)?;
        if has_column(&field_type) {
            tx.execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", table_id, fid), [])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(fid)
    })
}

#[tauri::command]
pub fn field_update(
    state: State<'_, Db>,
    field_id: String,
    name: Option<String>,
    options: Option<Json>,
) -> Result<(), String> {
    with_base(&state, |b| {
        field_meta(&b.conn, &field_id)?;
        if let Some(n) = name {
            let n = n.trim().to_string();
            if n.is_empty() {
                return err("nome de campo vazio");
            }
            b.conn
                .execute("UPDATE _taylor_fields SET name = ?1 WHERE id = ?2", rusqlite::params![n, field_id])
                .map_err(db_err)?;
        }
        if let Some(o) = options {
            b.conn
                .execute(
                    "UPDATE _taylor_fields SET options = ?1 WHERE id = ?2",
                    rusqlite::params![o.to_string(), field_id],
                )
                .map_err(db_err)?;
        }
        Ok(())
    })
}

/// Muda o tipo de um campo convertendo os valores existentes (melhor esforço).
/// Como o SQLite não impõe tipo por coluna, não há rebuild de tabela: os dados
/// são convertidos linha a linha dentro de uma transação.
#[tauri::command]
pub fn field_change_type(
    state: State<'_, Db>,
    field_id: String,
    field_type: String,
    options: Option<Json>,
) -> Result<Json, String> {
    if !FIELD_TYPES.contains(&field_type.as_str()) {
        return err(format!("tipo de campo desconhecido: '{}'", field_type));
    }
    with_base(&state, |b| {
        let (table_id, old_type, _old_options) = field_meta(&b.conn, &field_id)?;
        let mut new_options = options.unwrap_or(json!({}));
        let tx = b.conn.transaction().map_err(db_err)?;

        // formula <-> coluna real: criar/derrubar a coluna
        if has_column(&old_type) && !has_column(&field_type) {
            tx.execute(&format!("ALTER TABLE \"t_{}\" DROP COLUMN \"c_{}\"", table_id, field_id), [])
                .map_err(db_err)?;
        } else if !has_column(&old_type) && has_column(&field_type) {
            tx.execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", table_id, field_id), [])
                .map_err(db_err)?;
        } else if has_column(&field_type) {
            // conversão de valores
            let col = format!("\"c_{}\"", field_id);
            let sel = format!("SELECT id, {} FROM \"t_{}\" WHERE {} IS NOT NULL", col, table_id, col);
            let mut rows: Vec<(i64, Json)> = Vec::new();
            {
                let mut stmt = tx.prepare(&sel).map_err(db_err)?;
                let mapped = stmt
                    .query_map([], |r| Ok((r.get::<_, i64>(0)?, sql_to_json(&old_type, r.get_ref(1)?))))
                    .map_err(db_err)?;
                for m in mapped {
                    rows.push(m.map_err(db_err)?);
                }
            }
            // texto -> select: cria as opções a partir dos valores distintos
            if field_type == "select" && new_options.get("choices").is_none() {
                let mut choices: Vec<Json> = Vec::new();
                for (_, v) in &rows {
                    if let Some(s) = v.as_str() {
                        let s = s.trim();
                        if !s.is_empty()
                            && !choices.iter().any(|c| c.get("name").and_then(|n| n.as_str()) == Some(s))
                            && choices.len() < 100
                        {
                            choices.push(json!({"id": new_id(), "name": s, "color": ""}));
                        }
                    }
                }
                new_options = json!({ "choices": choices });
            }
            let upd = format!("UPDATE \"t_{}\" SET {} = ? WHERE id = ?", table_id, col);
            for (id, old_val) in rows {
                let converted = convert_value(&old_type, &field_type, &new_options, &old_val);
                let sql_val = match &converted {
                    Json::Null => SqlValue::Null,
                    v => cell_to_sql(&field_type, &new_options, v).unwrap_or(SqlValue::Null),
                };
                tx.execute(&upd, rusqlite::params![sql_val, id]).map_err(db_err)?;
            }
        }
        tx.execute(
            "UPDATE _taylor_fields SET type = ?1, options = ?2 WHERE id = ?3",
            rusqlite::params![field_type, new_options.to_string(), field_id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(new_options)
    })
}

/// Conversão de valor entre tipos (melhor esforço; falha vira NULL).
fn convert_value(old_type: &str, new_type: &str, new_options: &Json, v: &Json) -> Json {
    if v.is_null() {
        return Json::Null;
    }
    let as_text = || -> String {
        match v {
            Json::String(s) => s.clone(),
            Json::Number(n) => n.to_string(),
            Json::Bool(b) => (if *b { "sim" } else { "não" }).to_string(),
            Json::Array(a) => a
                .iter()
                .map(|x| x.as_str().map(|s| s.to_string()).unwrap_or_else(|| x.to_string()))
                .collect::<Vec<_>>()
                .join(", "),
            _ => v.to_string(),
        }
    };
    match new_type {
        "text" | "long_text" => {
            // select armazenava o id da opção — sem acesso às opções antigas aqui,
            // o frontend manda converter via nome quando importa (aceito o id).
            json!(as_text())
        }
        "number" => match v {
            Json::Number(_) => v.clone(),
            Json::String(s) => s.trim().replace(',', ".").parse::<f64>().map(|f| json!(f)).unwrap_or(Json::Null),
            Json::Bool(b) => json!(*b as i64 as f64),
            _ => Json::Null,
        },
        "checkbox" => match v {
            Json::Bool(_) => v.clone(),
            Json::Number(n) => json!(n.as_f64().unwrap_or(0.0) != 0.0),
            Json::String(s) => {
                let s = s.trim().to_lowercase();
                json!(matches!(s.as_str(), "1" | "true" | "sim" | "yes" | "x" | "✓"))
            }
            _ => Json::Null,
        },
        "date" => match v {
            Json::String(s) if s.len() >= 10 => v.clone(),
            _ => Json::Null,
        },
        "select" => {
            // casa o TEXTO com o nome de uma opção
            let s = as_text();
            let s = s.trim();
            if let Some(choices) = new_options.get("choices").and_then(|c| c.as_array()) {
                for c in choices {
                    if c.get("name").and_then(|n| n.as_str()) == Some(s) {
                        return c.get("id").cloned().unwrap_or(Json::Null);
                    }
                }
            }
            let _ = old_type;
            Json::Null
        }
        "multi_select" | "link" | "attachment" => match v {
            Json::Array(_) => v.clone(),
            _ => json!([]),
        },
        _ => Json::Null,
    }
}

#[tauri::command]
pub fn field_delete(state: State<'_, Db>, field_id: String) -> Result<(), String> {
    with_base(&state, |b| {
        let (table_id, ftype, _) = field_meta(&b.conn, &field_id)?;
        let n: i64 = b
            .conn
            .query_row("SELECT COUNT(*) FROM _taylor_fields WHERE table_id = ?1", [&table_id], |r| r.get(0))
            .map_err(db_err)?;
        if n <= 1 {
            return err("a tabela precisa de pelo menos um campo");
        }
        let tx = b.conn.transaction().map_err(db_err)?;
        if has_column(&ftype) {
            tx.execute(&format!("ALTER TABLE \"t_{}\" DROP COLUMN \"c_{}\"", table_id, field_id), [])
                .map_err(db_err)?;
        }
        tx.execute("DELETE FROM _taylor_fields WHERE id = ?1", [&field_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    })
}

#[tauri::command]
pub fn fields_reorder(state: State<'_, Db>, table_id: String, ids: Vec<String>) -> Result<(), String> {
    with_base(&state, |b| {
        let tx = b.conn.transaction().map_err(db_err)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE _taylor_fields SET pos = ?1 WHERE id = ?2 AND table_id = ?3",
                rusqlite::params![i as i64, id, table_id],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Comandos: registros
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub rows: Vec<Json>,
    pub total: i64,
}

fn row_to_json(fields: &[FieldMeta], row: &rusqlite::Row<'_>) -> Result<Json, rusqlite::Error> {
    let id: i64 = row.get(0)?;
    let mut cells = serde_json::Map::new();
    let mut col = 1usize;
    for f in fields {
        if !has_column(&f.ftype) {
            continue;
        }
        cells.insert(f.id.clone(), sql_to_json(&f.ftype, row.get_ref(col)?));
        col += 1;
    }
    Ok(json!({ "id": id, "cells": cells }))
}

fn select_cols(fields: &[FieldMeta]) -> String {
    let mut cols = vec!["id".to_string()];
    for f in fields {
        if has_column(&f.ftype) {
            cols.push(format!("\"c_{}\"", f.id));
        }
    }
    cols.join(", ")
}

#[tauri::command]
pub fn records_query(
    state: State<'_, Db>,
    table_id: String,
    #[allow(non_snake_case)] filters: Option<Vec<Filter>>,
    sorts: Option<Vec<Sort>>,
    search: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<QueryResult, String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let filters = filters.unwrap_or_default();
        let sorts = sorts.unwrap_or_default();
        let (where_sql, params) = build_where(&filters, &search, &fields)?;
        let order_sql = build_order(&sorts, &fields)?;

        let total: i64 = b
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"t_{}\"{}", table_id, where_sql),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .map_err(db_err)?;

        let mut sql = format!("SELECT {} FROM \"t_{}\"{}{}", select_cols(&fields), table_id, where_sql, order_sql);
        if let Some(l) = limit {
            sql.push_str(&format!(" LIMIT {}", l.max(0)));
            if let Some(o) = offset {
                sql.push_str(&format!(" OFFSET {}", o.max(0)));
            }
        }
        let mut stmt = b.conn.prepare(&sql).map_err(db_err)?;
        let mapped = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| row_to_json(&fields, r))
            .map_err(db_err)?;
        let mut rows = Vec::new();
        for m in mapped {
            rows.push(m.map_err(db_err)?);
        }
        Ok(QueryResult { rows, total })
    })
}

#[tauri::command]
pub fn records_by_ids(state: State<'_, Db>, table_id: String, ids: Vec<i64>) -> Result<Vec<Json>, String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT {} FROM \"t_{}\" WHERE id IN ({})",
            select_cols(&fields),
            table_id,
            marks
        );
        let mut stmt = b.conn.prepare(&sql).map_err(db_err)?;
        let mapped = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |r| row_to_json(&fields, r))
            .map_err(db_err)?;
        let mut rows = Vec::new();
        for m in mapped {
            rows.push(m.map_err(db_err)?);
        }
        Ok(rows)
    })
}

/// Valida `cells` contra o schema e monta (colunas, valores).
fn validated_cells(
    fields: &[FieldMeta],
    cells: &serde_json::Map<String, Json>,
) -> Result<(Vec<String>, Vec<SqlValue>), String> {
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for (fid, v) in cells {
        let meta = fields
            .iter()
            .find(|m| &m.id == fid)
            .ok_or(format!("campo inexistente: '{}'", fid))?;
        if !has_column(&meta.ftype) {
            return err(format!("campo '{}' é de fórmula (somente leitura)", meta.name));
        }
        let sql_val = cell_to_sql(&meta.ftype, &meta.options, v)
            .map_err(|e| format!("campo '{}': {}", meta.name, e))?;
        cols.push(format!("\"c_{}\"", fid));
        vals.push(sql_val);
    }
    Ok((cols, vals))
}

#[tauri::command]
pub fn record_create(state: State<'_, Db>, table_id: String, cells: Json) -> Result<i64, String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let map = cells.as_object().cloned().unwrap_or_default();
        let (cols, vals) = validated_cells(&fields, &map)?;
        if cols.is_empty() {
            b.conn
                .execute(&format!("INSERT INTO \"t_{}\" DEFAULT VALUES", table_id), [])
                .map_err(db_err)?;
        } else {
            let marks = vec!["?"; cols.len()].join(",");
            b.conn
                .execute(
                    &format!("INSERT INTO \"t_{}\" ({}) VALUES ({})", table_id, cols.join(","), marks),
                    rusqlite::params_from_iter(vals.iter()),
                )
                .map_err(db_err)?;
        }
        Ok(b.conn.last_insert_rowid())
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordUpdate {
    pub id: i64,
    pub cells: Json,
}

#[tauri::command]
pub fn records_update(state: State<'_, Db>, table_id: String, updates: Vec<RecordUpdate>) -> Result<(), String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        for u in &updates {
            let map = u.cells.as_object().cloned().unwrap_or_default();
            let (cols, mut vals) = validated_cells(&fields, &map)?;
            if cols.is_empty() {
                continue;
            }
            let sets = cols.iter().map(|c| format!("{} = ?", c)).collect::<Vec<_>>().join(", ");
            vals.push(SqlValue::Integer(u.id));
            let n = tx
                .execute(
                    &format!("UPDATE \"t_{}\" SET {} WHERE id = ?", table_id, sets),
                    rusqlite::params_from_iter(vals.iter()),
                )
                .map_err(db_err)?;
            if n == 0 {
                return err(format!("registro {} não encontrado", u.id));
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    })
}

#[tauri::command]
pub fn records_delete(state: State<'_, Db>, table_id: String, ids: Vec<i64>) -> Result<(), String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        if ids.is_empty() {
            return Ok(());
        }
        let marks = vec!["?"; ids.len()].join(",");
        b.conn
            .execute(
                &format!("DELETE FROM \"t_{}\" WHERE id IN ({})", table_id, marks),
                rusqlite::params_from_iter(ids.iter()),
            )
            .map_err(db_err)?;
        Ok(())
    })
}

#[tauri::command]
pub fn records_insert_bulk(state: State<'_, Db>, table_id: String, rows: Vec<Json>) -> Result<i64, String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        let mut count = 0i64;
        for row in &rows {
            let map = row.as_object().cloned().unwrap_or_default();
            let (cols, vals) = validated_cells(&fields, &map)?;
            if cols.is_empty() {
                tx.execute(&format!("INSERT INTO \"t_{}\" DEFAULT VALUES", table_id), [])
                    .map_err(db_err)?;
            } else {
                let marks = vec!["?"; cols.len()].join(",");
                tx.execute(
                    &format!("INSERT INTO \"t_{}\" ({}) VALUES ({})", table_id, cols.join(","), marks),
                    rusqlite::params_from_iter(vals.iter()),
                )
                .map_err(db_err)?;
            }
            count += 1;
        }
        tx.commit().map_err(db_err)?;
        Ok(count)
    })
}

// ---------------------------------------------------------------------------
// Comandos: views
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn view_create(
    state: State<'_, Db>,
    table_id: String,
    name: String,
    kind: String,
    config: Json,
) -> Result<String, String> {
    const KINDS: &[&str] = &["grid", "kanban", "calendar", "gallery", "form"];
    if !KINDS.contains(&kind.as_str()) {
        return err(format!("tipo de view desconhecido: '{}'", kind));
    }
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let vid = new_id();
        let pos: i64 = b
            .conn
            .query_row(
                "SELECT COALESCE(MAX(pos), -1) + 1 FROM _taylor_views WHERE table_id = ?1",
                [&table_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        b.conn
            .execute(
                "INSERT INTO _taylor_views(id, table_id, name, kind, config, pos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![vid, table_id, name, kind, config.to_string(), pos],
            )
            .map_err(db_err)?;
        Ok(vid)
    })
}

#[tauri::command]
pub fn view_update(
    state: State<'_, Db>,
    view_id: String,
    name: Option<String>,
    config: Option<Json>,
) -> Result<(), String> {
    with_base(&state, |b| {
        if let Some(n) = name {
            b.conn
                .execute("UPDATE _taylor_views SET name = ?1 WHERE id = ?2", rusqlite::params![n, view_id])
                .map_err(db_err)?;
        }
        if let Some(c) = config {
            b.conn
                .execute(
                    "UPDATE _taylor_views SET config = ?1 WHERE id = ?2",
                    rusqlite::params![c.to_string(), view_id],
                )
                .map_err(db_err)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn view_delete(state: State<'_, Db>, view_id: String) -> Result<(), String> {
    with_base(&state, |b| {
        let table_id: Option<String> = b
            .conn
            .query_row("SELECT table_id FROM _taylor_views WHERE id = ?1", [&view_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        let table_id = table_id.ok_or("view não encontrada")?;
        let n: i64 = b
            .conn
            .query_row("SELECT COUNT(*) FROM _taylor_views WHERE table_id = ?1", [&table_id], |r| r.get(0))
            .map_err(db_err)?;
        if n <= 1 {
            return err("a tabela precisa de pelo menos uma view");
        }
        b.conn.execute("DELETE FROM _taylor_views WHERE id = ?1", [&view_id]).map_err(db_err)?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Comandos: anexos (blobs dentro do .tbase — a base continua um arquivo só)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
}

fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn attachment_import(state: State<'_, Db>, paths: Vec<String>) -> Result<Vec<AttachmentMeta>, String> {
    with_base(&state, |b| {
        let mut out = Vec::new();
        let tx = b.conn.transaction().map_err(db_err)?;
        for p in &paths {
            let data = std::fs::read(p).map_err(|e| format!("falha ao ler '{}': {}", p, e))?;
            let name = std::path::Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("arquivo")
                .to_string();
            let id = new_id();
            let mime = guess_mime(&name).to_string();
            let size = data.len() as i64;
            tx.execute(
                "INSERT INTO _taylor_blobs(id, name, mime, size, data) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, name, mime, size, data],
            )
            .map_err(db_err)?;
            out.push(AttachmentMeta { id, name, mime, size });
        }
        tx.commit().map_err(db_err)?;
        Ok(out)
    })
}

#[tauri::command]
pub fn attachment_read(state: State<'_, Db>, id: String) -> Result<String, String> {
    use base64::Engine;
    with_base(&state, |b| {
        let data: Option<Vec<u8>> = b
            .conn
            .query_row("SELECT data FROM _taylor_blobs WHERE id = ?1", [&id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        match data {
            Some(d) => Ok(base64::engine::general_purpose::STANDARD.encode(d)),
            None => err("anexo não encontrado"),
        }
    })
}

#[tauri::command]
pub fn attachment_metas(state: State<'_, Db>, ids: Vec<String>) -> Result<Vec<AttachmentMeta>, String> {
    with_base(&state, |b| {
        let mut out = Vec::new();
        for id in &ids {
            let meta = b
                .conn
                .query_row(
                    "SELECT id, name, mime, size FROM _taylor_blobs WHERE id = ?1",
                    [id],
                    |r| {
                        Ok(AttachmentMeta {
                            id: r.get(0)?,
                            name: r.get(1)?,
                            mime: r.get(2)?,
                            size: r.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(db_err)?;
            if let Some(m) = meta {
                out.push(m);
            }
        }
        Ok(out)
    })
}

/// Remove blobs que nenhuma célula de anexo referencia mais (chamado pelo
/// frontend de vez em quando; barato o suficiente pra rodar ao fechar).
#[tauri::command]
pub fn attachments_gc(state: State<'_, Db>) -> Result<i64, String> {
    with_base(&state, |b| {
        let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
        let tables: Vec<String> = {
            let mut stmt = b.conn.prepare("SELECT id FROM _taylor_tables").map_err(db_err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        };
        for tid in &tables {
            let fields = table_fields(&b.conn, tid)?;
            for f in fields.iter().filter(|f| f.ftype == "attachment") {
                let sql = format!("SELECT \"c_{}\" FROM \"t_{}\" WHERE \"c_{}\" IS NOT NULL", f.id, tid, f.id);
                let mut stmt = b.conn.prepare(&sql).map_err(db_err)?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
                for row in rows {
                    let txt = row.map_err(db_err)?;
                    if let Ok(Json::Array(ids)) = serde_json::from_str::<Json>(&txt) {
                        for id in ids {
                            if let Some(s) = id.as_str() {
                                referenced.insert(s.to_string());
                            }
                        }
                    }
                }
            }
        }
        let all: Vec<String> = {
            let mut stmt = b.conn.prepare("SELECT id FROM _taylor_blobs").map_err(db_err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        };
        let mut removed = 0i64;
        for id in all {
            if !referenced.contains(&id) {
                b.conn.execute("DELETE FROM _taylor_blobs WHERE id = ?1", [&id]).map_err(db_err)?;
                removed += 1;
            }
        }
        Ok(removed)
    })
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_base() -> Base {
        let conn = Connection::open_in_memory().unwrap();
        init_meta(&conn).unwrap();
        create_default_table(&conn, "Tarefas").unwrap();
        Base { conn, path: PathBuf::from("test.tbase") }
    }

    #[test]
    fn cria_schema_default() {
        let b = memory_base();
        let s = read_schema(&b.conn, &b.path).unwrap();
        assert_eq!(s.tables.len(), 1);
        assert_eq!(s.tables[0].name, "Tarefas");
        assert_eq!(s.tables[0].fields.len(), 2);
        assert_eq!(s.tables[0].views.len(), 1);
        assert_eq!(s.tables[0].views[0].kind, "grid");
    }

    #[test]
    fn valida_celulas_por_tipo() {
        let opts = json!({"choices": [{"id": "c1", "name": "Alta", "color": "#f00"}]});
        assert!(matches!(cell_to_sql("number", &json!({}), &json!("12,5")).unwrap(), SqlValue::Real(f) if (f - 12.5).abs() < 1e-9));
        assert!(cell_to_sql("number", &json!({}), &json!("abc")).is_err());
        assert!(matches!(cell_to_sql("checkbox", &json!({}), &json!(true)).unwrap(), SqlValue::Integer(1)));
        assert!(cell_to_sql("date", &json!({}), &json!("2026-07-06")).is_ok());
        assert!(cell_to_sql("date", &json!({}), &json!("06/07/2026")).is_err());
        assert!(cell_to_sql("select", &opts, &json!("c1")).is_ok());
        assert!(cell_to_sql("select", &opts, &json!("zzz")).is_err());
        assert!(cell_to_sql("multi_select", &opts, &json!(["c1"])).is_ok());
        assert!(cell_to_sql("link", &json!({}), &json!([1, 2])).is_ok());
        assert!(cell_to_sql("link", &json!({}), &json!(["a"])).is_err());
        assert!(cell_to_sql("formula", &json!({}), &json!("x")).is_err());
    }

    #[test]
    fn insere_filtra_ordena() {
        let b = memory_base();
        let fields = {
            let s = read_schema(&b.conn, &b.path).unwrap();
            s.tables[0].clone()
        };
        let name_f = &fields.fields[0].id;
        // campo número
        let num_f = new_id();
        b.conn
            .execute(
                "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1, ?2, 'Preço', 'number', '{}', 5)",
                rusqlite::params![num_f, fields.id],
            )
            .unwrap();
        b.conn
            .execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", fields.id, num_f), [])
            .unwrap();

        let all_fields = table_fields(&b.conn, &fields.id).unwrap();
        for (n, p) in [("Banana", 3.5), ("Abacate", 8.0), ("Cenoura", 2.0)] {
            let map: serde_json::Map<String, Json> =
                [(name_f.clone(), json!(n)), (num_f.clone(), json!(p))].into_iter().collect();
            let (cols, vals) = validated_cells(&all_fields, &map).unwrap();
            let marks = vec!["?"; cols.len()].join(",");
            b.conn
                .execute(
                    &format!("INSERT INTO \"t_{}\" ({}) VALUES ({})", fields.id, cols.join(","), marks),
                    rusqlite::params_from_iter(vals.iter()),
                )
                .unwrap();
        }

        // filtro: preço > 3
        let filters = vec![Filter { field_id: num_f.clone(), op: "gt".into(), value: json!(3) }];
        let (where_sql, params) = build_where(&filters, &None, &all_fields).unwrap();
        let count: i64 = b
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"t_{}\"{}", fields.id, where_sql),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);

        // ordenação por nome
        let sorts = vec![Sort { field_id: name_f.clone(), desc: false }];
        let order = build_order(&sorts, &all_fields).unwrap();
        let sql = format!("SELECT {} FROM \"t_{}\"{}", select_cols(&all_fields), fields.id, order);
        let mut stmt = b.conn.prepare(&sql).unwrap();
        let rows: Vec<Json> = stmt
            .query_map([], |r| row_to_json(&all_fields, r))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows[0]["cells"][name_f.as_str()], json!("Abacate"));

        // busca
        let (where_sql, params) = build_where(&[], &Some("cen".into()), &all_fields).unwrap();
        let count: i64 = b
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"t_{}\"{}", fields.id, where_sql),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn converte_texto_para_select() {
        // simula a conversão text -> select com auto-criação de choices
        let vals = ["Alta", "Baixa", "Alta", ""];
        let mut choices: Vec<Json> = Vec::new();
        for v in vals {
            let v = v.trim();
            if !v.is_empty() && !choices.iter().any(|c| c["name"] == json!(v)) {
                choices.push(json!({"id": new_id(), "name": v, "color": ""}));
            }
        }
        let opts = json!({ "choices": choices });
        assert_eq!(opts["choices"].as_array().unwrap().len(), 2);
        let conv = convert_value("text", "select", &opts, &json!("Alta"));
        assert!(conv.is_string());
        let miss = convert_value("text", "select", &opts, &json!("Média"));
        assert!(miss.is_null());
    }

    #[test]
    fn ids_sao_unicos_e_hex() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let id = new_id();
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn filtro_has_record_em_link() {
        let f = Filter { field_id: "x".into(), op: "has_record".into(), value: json!(7) };
        let fields = vec![FieldMeta {
            id: "x".into(),
            name: "Rel".into(),
            ftype: "link".into(),
            options: json!({}),
            pos: 0,
        }];
        let (sql, params) = filter_sql(&f, &fields).unwrap();
        assert!(sql.contains("LIKE"));
        assert_eq!(params.len(), 4);
    }
}
