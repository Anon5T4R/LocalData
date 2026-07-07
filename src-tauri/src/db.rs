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
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct Base {
    pub conn: Connection,
    pub path: PathBuf,
    /// Rastreio de mudanças pro polling (GUI local + clientes remotos):
    /// contador global e o "quando" de cada tabela/schema.
    pub seq: u64,
    pub schema_seq: u64,
    pub table_seq: HashMap<String, u64>,
}

impl Base {
    pub fn new(conn: Connection, path: PathBuf) -> Self {
        Base { conn, path, seq: 0, schema_seq: 0, table_seq: HashMap::new() }
    }

    /// Registra mudança de DADOS numa tabela (linhas criadas/alteradas/excluídas).
    pub fn bump_data(&mut self, table_id: &str) {
        self.seq += 1;
        self.table_seq.insert(table_id.to_string(), self.seq);
    }

    /// Registra mudança de SCHEMA (tabelas/campos/views/automações).
    pub fn bump_schema(&mut self) {
        self.seq += 1;
        self.schema_seq = self.seq;
    }
}

/// Estado do banco. `Clone` compartilha o MESMO banco (Arc) — é o que permite
/// o servidor HTTP (server.rs) atender a base aberta na GUI: todos os acessos
/// serializam no mesmo Mutex, então o SQLite nunca vê escrita concorrente.
#[derive(Clone, Default)]
pub struct Db(pub Arc<Mutex<Option<Base>>>);

const SCHEMA_VERSION: i64 = 1;

/// Nome de quem está operando: usuário do servidor (injetado pelo dispatch em
/// server.rs) ou o usuário local da máquina.
pub fn actor_name(actor: &Option<String>) -> String {
    actor.clone().unwrap_or_else(|| {
        std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "local".into())
    })
}

/// Tipos de campo suportados. "formula", "lookup" e "rollup" são computados
/// no frontend e não têm coluna. "custom" é o tipo das EXTENSÕES: no banco é
/// sempre TEXT (validação/máscara ficam na extensão JS, no frontend) — a
/// robustez do SQL não depende de código de terceiros.
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
    "rating",
    "url",
    "email",
    "phone",
    "lookup",
    "rollup",
    "custom",
];

fn has_column(ftype: &str) -> bool {
    !matches!(ftype, "formula" | "lookup" | "rollup")
}

/// Tipos armazenados como texto livre (validação leve; a UI orienta o formato).
fn is_textlike(ftype: &str) -> bool {
    matches!(ftype, "text" | "long_text" | "url" | "email" | "phone" | "custom")
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
            size INTEGER NOT NULL, data BLOB NOT NULL);
         CREATE TABLE IF NOT EXISTS _taylor_users(
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
            salt TEXT NOT NULL, hash TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS _taylor_perms(
            user_id TEXT NOT NULL, table_id TEXT NOT NULL, level TEXT NOT NULL,
            PRIMARY KEY (user_id, table_id));
         CREATE TABLE IF NOT EXISTS _taylor_audit(
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
            actor TEXT NOT NULL, action TEXT NOT NULL,
            table_id TEXT, record_id INTEGER, detail TEXT NOT NULL DEFAULT '{}');
         CREATE INDEX IF NOT EXISTS _taylor_audit_rec ON _taylor_audit(table_id, record_id);
         CREATE TABLE IF NOT EXISTS _taylor_automations(
            id TEXT PRIMARY KEY, table_id TEXT NOT NULL,
            config TEXT NOT NULL DEFAULT '{}', pos INTEGER NOT NULL DEFAULT 0);",
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
        "text" | "long_text" | "url" | "email" | "phone" | "custom" => match v {
            Json::String(s) => Ok(SqlValue::Text(s.clone())),
            Json::Number(n) => Ok(SqlValue::Text(n.to_string())),
            Json::Bool(b) => Ok(SqlValue::Text(b.to_string())),
            _ => err("texto inválido"),
        },
        "rating" => {
            // inteiro 0..max (default 5); 0/null limpa
            let max = options.get("ratingMax").and_then(|m| m.as_i64()).unwrap_or(5).clamp(1, 10);
            let n = match v {
                Json::Number(n) => n.as_f64().unwrap_or(0.0),
                Json::String(s) => {
                    let s = s.trim().replace(',', ".");
                    if s.is_empty() {
                        return Ok(SqlValue::Null);
                    }
                    s.parse::<f64>().map_err(|_| format!("avaliação inválida: '{}'", s))?
                }
                _ => return err("avaliação inválida"),
            };
            let n = n.round() as i64;
            if n <= 0 {
                Ok(SqlValue::Null)
            } else {
                Ok(SqlValue::Integer(n.min(max)))
            }
        }
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
        "formula" | "lookup" | "rollup" => err("campo computado é somente leitura"),
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
        "number" | "rating" => match v {
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
        return err("não é possível filtrar por campo computado");
    }
    let is_numeric = matches!(meta.ftype.as_str(), "number" | "rating");
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
            if is_numeric {
                let n = vnum.ok_or("valor numérico inválido no filtro")?;
                Ok((format!("CAST({} AS REAL) = ?", col), vec![SqlValue::Real(n)]))
            } else {
                Ok((format!("{} = ?", col), vec![SqlValue::Text(vstr)]))
            }
        }
        "neq" => {
            if is_numeric {
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
            if is_numeric {
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
                if is_textlike(&m.ftype) || m.ftype == "date" {
                    ors.push(format!("\"c_{}\" LIKE ? ESCAPE '\\'", m.id));
                    params.push(SqlValue::Text(format!("%{}%", like_escape(q))));
                } else if matches!(m.ftype.as_str(), "number" | "rating") {
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
            return err("não é possível ordenar por campo computado");
        }
        let col = format!("\"c_{}\"", meta.id);
        let dir = if s.desc { "DESC" } else { "ASC" };
        let expr = match meta.ftype.as_str() {
            "number" | "rating" => format!("CAST({} AS REAL) {}", col, dir),
            t if is_textlike(t) || t == "select" => format!("{} COLLATE NOCASE {}", col, dir),
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

/// Acesso serializado à base aberta. Recebe `&Db` (não `State`) de propósito:
/// o servidor HTTP usa exatamente o mesmo caminho que os comandos Tauri.
pub fn with_base<T>(db: &Db, f: impl FnOnce(&mut Base) -> Result<T, String>) -> Result<T, String> {
    let mut guard = db.0.lock().map_err(|_| "estado do banco corrompido")?;
    match guard.as_mut() {
        Some(base) => f(base),
        None => err("nenhuma base aberta"),
    }
}

/// Agora ISO (UTC) sem depender de crate de data: via SQLite.
fn now_iso(conn: &Connection) -> String {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| r.get(0))
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

/// Trilha de auditoria: sempre dentro da MESMA transação da mutação.
pub fn log_audit(
    conn: &Connection,
    actor: &str,
    action: &str,
    table_id: Option<&str>,
    record_id: Option<i64>,
    detail: &Json,
) {
    // truncamento defensivo: célula gigante não incha a trilha
    let mut d = detail.to_string();
    if d.len() > 4000 {
        d.truncate(4000);
        d.push('…');
    }
    let ts = now_iso(conn);
    let _ = conn.execute(
        "INSERT INTO _taylor_audit(ts, actor, action, table_id, record_id, detail) VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![ts, actor, action, table_id, record_id, d],
    );
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

/// Backup ao abrir: copia o arquivo pra pasta central de backups e mantém só
/// as `keep` cópias mais novas DESTA base (hash do caminho distingue bases
/// homônimas). Melhor esforço: falha de backup nunca impede a abertura.
fn backup_base(app: &tauri::AppHandle, path: &PathBuf, keep: u32) {
    use tauri::Manager;
    if keep == 0 {
        return;
    }
    let Ok(cfg) = app.path().app_config_dir() else { return };
    let dir = cfg.join("backups");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut h);
    let tag = format!("{:08x}", h.finish() as u32);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("base");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = dir.join(format!("{}-{}-{:010}.tbase", stem, tag, ts));
    if std::fs::copy(path, &dest).is_err() {
        return;
    }
    // poda: nomes têm timestamp de largura fixa — ordenar por nome = por data
    let prefix = format!("{}-{}-", stem, tag);
    let mut mine: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with(&prefix))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    mine.sort();
    while mine.len() > keep as usize {
        let oldest = mine.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
}

/// Pasta central de backups (pra UI abrir no gerenciador de arquivos).
#[tauri::command(async)]
pub fn backups_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("sem pasta de configuração: {}", e))?
        .join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("falha ao criar '{}': {}", dir.display(), e))?;
    Ok(dir.to_string_lossy().to_string())
}

fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("falha ao abrir '{}': {}", path.display(), e))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(db_err)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Comandos: base
// ---------------------------------------------------------------------------

#[tauri::command(async)]
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
    *guard = Some(Base::new(conn, p));
    Ok(schema)
}

/// Abre a base SEM Tauri (usado pelo modo headless `--serve` e pelos testes).
pub fn open_base_impl(db: &Db, path: &str) -> Result<BaseSchema, String> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return err(format!("arquivo não encontrado: '{}'", path));
    }
    let conn = open_connection(&p)?;
    let version: i64 = conn
        .query_row("SELECT value FROM _taylor_meta WHERE key = 'schema_version'", [], |r| {
            r.get::<_, String>(0)
        })
        .map(|v| v.parse().unwrap_or(0))
        .unwrap_or(0);
    if version > SCHEMA_VERSION {
        return err("esta base foi criada por uma versão mais nova do LocalData");
    }
    // Idempotente: instala/completa os metadados. Permite abrir um SQLite
    // alheio (as tabelas dele ficam intocadas) e adiciona as _taylor_* novas
    // (users/audit/automations) em bases criadas por versões antigas.
    init_meta(&conn)?;
    let schema = read_schema(&conn, &p)?;
    let mut guard = db.0.lock().map_err(|_| "estado do banco corrompido")?;
    *guard = Some(Base::new(conn, p));
    Ok(schema)
}

#[tauri::command(async)]
pub fn base_open(
    app: tauri::AppHandle,
    state: State<'_, Db>,
    path: String,
    backup_keep: Option<u32>,
) -> Result<BaseSchema, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return err(format!("arquivo não encontrado: '{}'", path));
    }
    // antes de abrir: cópia de segurança (retenção configurável; 0 desliga)
    backup_base(&app, &p, backup_keep.unwrap_or(10).min(500));
    open_base_impl(&state, &path)
}

#[tauri::command(async)]
pub fn base_close(state: State<'_, Db>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "estado do banco corrompido")?;
    *guard = None;
    Ok(())
}

#[tauri::command(async)]
pub fn base_schema(state: State<'_, Db>) -> Result<BaseSchema, String> {
    with_base(&state, |b| read_schema(&b.conn, &b.path))
}

// ---------------------------------------------------------------------------
// Mudanças (polling): GUI local e clientes remotos perguntam "o que mudou?"
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub seq: u64,
    pub schema_changed: bool,
    pub tables: Vec<String>,
}

#[tauri::command(async)]
pub fn changes_since(state: State<'_, Db>, since: u64) -> Result<Changes, String> {
    with_base(&state, |b| {
        Ok(Changes {
            seq: b.seq,
            schema_changed: b.schema_seq > since,
            tables: b
                .table_seq
                .iter()
                .filter(|(_, s)| **s > since)
                .map(|(t, _)| t.clone())
                .collect(),
        })
    })
}

// ---------------------------------------------------------------------------
// Usuários e permissões (modo servidor). Guardados NA BASE (_taylor_users):
// viajam com o arquivo; quem tem o arquivo é dono (modo local = admin).
// Papéis: leitor (só lê) < editor (lê + muda REGISTROS) < admin (tudo).
// Override por tabela (_taylor_perms): none/read/edit — vale pros comandos de
// registro, que sempre têm table_id explícito.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub role: String,
    pub perms: HashMap<String, String>, // table_id -> none|read|edit
}

pub const ROLES: &[&str] = &["leitor", "editor", "admin"];

fn hash_password(conn: &Connection, password: &str) -> Result<(String, String), String> {
    use argon2::Argon2;
    let salt: Vec<u8> = conn
        .query_row("SELECT randomblob(16)", [], |r| r.get(0))
        .map_err(db_err)?;
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|e| format!("falha ao processar a senha: {}", e))?;
    Ok((hex_of(&salt), hex_of(&out)))
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .filter_map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// Confere credenciais; devolve (id, name, role) se ok.
pub fn verify_login(db: &Db, name: &str, password: &str) -> Result<(String, String, String), String> {
    use argon2::Argon2;
    with_base(db, |b| {
        let row: Option<(String, String, String, String, String)> = b
            .conn
            .query_row(
                "SELECT id, name, role, salt, hash FROM _taylor_users WHERE name = ?1 COLLATE NOCASE",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(db_err)?;
        let (id, name, role, salt, hash) = row.ok_or("usuário ou senha inválidos")?;
        let mut out = [0u8; 32];
        Argon2::default()
            .hash_password_into(password.as_bytes(), &hex_to_bytes(&salt), &mut out)
            .map_err(|_| "usuário ou senha inválidos".to_string())?;
        if hex_of(&out) != hash {
            return err("usuário ou senha inválidos");
        }
        Ok((id, name, role))
    })
}

/// Nível efetivo de um usuário numa tabela (considerando o papel global).
pub fn table_level(db: &Db, user_id: &str, role: &str, table_id: &str) -> Result<String, String> {
    let base = match role {
        "admin" => return Ok("edit".into()),
        "editor" => "edit",
        _ => "read",
    };
    with_base(db, |b| {
        let over: Option<String> = b
            .conn
            .query_row(
                "SELECT level FROM _taylor_perms WHERE user_id = ?1 AND table_id = ?2",
                rusqlite::params![user_id, table_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        Ok(over.unwrap_or_else(|| base.to_string()))
    })
}

#[tauri::command(async)]
pub fn users_list(state: State<'_, Db>) -> Result<Vec<UserInfo>, String> {
    with_base(&state, |b| {
        let mut users: Vec<UserInfo> = {
            let mut stmt = b
                .conn
                .prepare("SELECT id, name, role FROM _taylor_users ORDER BY name")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(UserInfo { id: r.get(0)?, name: r.get(1)?, role: r.get(2)?, perms: HashMap::new() })
                })
                .map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        };
        for u in users.iter_mut() {
            let mut stmt = b
                .conn
                .prepare("SELECT table_id, level FROM _taylor_perms WHERE user_id = ?1")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([&u.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(db_err)?;
            for p in rows {
                let (t, l) = p.map_err(db_err)?;
                u.perms.insert(t, l);
            }
        }
        Ok(users)
    })
}

/// Cria/atualiza usuário. `password` vazio em edição mantém a senha atual.
#[tauri::command(async)]
pub fn user_save(
    state: State<'_, Db>,
    id: Option<String>,
    name: String,
    role: String,
    password: Option<String>,
    actor: Option<String>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de usuário vazio");
    }
    if !ROLES.contains(&role.as_str()) {
        return err(format!("papel desconhecido: '{}'", role));
    }
    let who = actor_name(&actor);
    with_base(&state, |b| {
        match id {
            Some(uid) => {
                b.conn
                    .execute(
                        "UPDATE _taylor_users SET name = ?1, role = ?2 WHERE id = ?3",
                        rusqlite::params![name, role, uid],
                    )
                    .map_err(db_err)?;
                if let Some(p) = password.filter(|p| !p.is_empty()) {
                    let (salt, hash) = hash_password(&b.conn, &p)?;
                    b.conn
                        .execute(
                            "UPDATE _taylor_users SET salt = ?1, hash = ?2 WHERE id = ?3",
                            rusqlite::params![salt, hash, uid],
                        )
                        .map_err(db_err)?;
                }
                log_audit(&b.conn, &who, "user_update", None, None, &json!({ "user": name }));
                Ok(uid)
            }
            None => {
                let p = password.unwrap_or_default();
                if p.is_empty() {
                    return err("senha obrigatória pra usuário novo");
                }
                let (salt, hash) = hash_password(&b.conn, &p)?;
                let uid = new_id();
                b.conn
                    .execute(
                        "INSERT INTO _taylor_users(id, name, role, salt, hash) VALUES (?1,?2,?3,?4,?5)",
                        rusqlite::params![uid, name, role, salt, hash],
                    )
                    .map_err(|e| match e {
                        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                            format!("já existe um usuário chamado '{}'", name)
                        }
                        other => db_err(other),
                    })?;
                log_audit(&b.conn, &who, "user_create", None, None, &json!({ "user": name, "role": role }));
                Ok(uid)
            }
        }
    })
}

#[tauri::command(async)]
pub fn user_delete(state: State<'_, Db>, user_id: String, actor: Option<String>) -> Result<(), String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        let name: Option<String> = b
            .conn
            .query_row("SELECT name FROM _taylor_users WHERE id = ?1", [&user_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        b.conn.execute("DELETE FROM _taylor_users WHERE id = ?1", [&user_id]).map_err(db_err)?;
        b.conn.execute("DELETE FROM _taylor_perms WHERE user_id = ?1", [&user_id]).map_err(db_err)?;
        log_audit(&b.conn, &who, "user_delete", None, None, &json!({ "user": name }));
        Ok(())
    })
}

/// Define o nível de um usuário numa tabela ("" remove o override).
#[tauri::command(async)]
pub fn user_set_perm(
    state: State<'_, Db>,
    user_id: String,
    table_id: String,
    level: String,
) -> Result<(), String> {
    if !level.is_empty() && !["none", "read", "edit"].contains(&level.as_str()) {
        return err(format!("nível desconhecido: '{}'", level));
    }
    with_base(&state, |b| {
        if level.is_empty() {
            b.conn
                .execute(
                    "DELETE FROM _taylor_perms WHERE user_id = ?1 AND table_id = ?2",
                    rusqlite::params![user_id, table_id],
                )
                .map_err(db_err)?;
        } else {
            b.conn
                .execute(
                    "INSERT INTO _taylor_perms(user_id, table_id, level) VALUES (?1,?2,?3)
                     ON CONFLICT(user_id, table_id) DO UPDATE SET level = excluded.level",
                    rusqlite::params![user_id, table_id, level],
                )
                .map_err(db_err)?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Comandos: tabelas
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn table_create(state: State<'_, Db>, name: String, actor: Option<String>) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de tabela vazio");
    }
    let who = actor_name(&actor);
    with_base(&state, |b| {
        let tx = b.conn.transaction().map_err(db_err)?;
        let tid = create_default_table(&tx, &name)?;
        log_audit(&tx, &who, "table_create", Some(&tid), None, &json!({ "name": name }));
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        Ok(tid)
    })
}

#[tauri::command(async)]
pub fn table_rename(state: State<'_, Db>, table_id: String, name: String, actor: Option<String>) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de tabela vazio");
    }
    let who = actor_name(&actor);
    with_base(&state, |b| {
        let n = b
            .conn
            .execute("UPDATE _taylor_tables SET name = ?1 WHERE id = ?2", rusqlite::params![name, table_id])
            .map_err(db_err)?;
        if n == 0 {
            return err("tabela não encontrada");
        }
        log_audit(&b.conn, &who, "table_rename", Some(&table_id), None, &json!({ "name": name }));
        b.bump_schema();
        Ok(())
    })
}

#[tauri::command(async)]
pub fn table_delete(state: State<'_, Db>, table_id: String, actor: Option<String>) -> Result<(), String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        let name: Option<String> = tx
            .query_row("SELECT name FROM _taylor_tables WHERE id = ?1", [&table_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        tx.execute(&format!("DROP TABLE IF EXISTS \"t_{}\"", table_id), []).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_fields WHERE table_id = ?1", [&table_id]).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_views WHERE table_id = ?1", [&table_id]).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_tables WHERE id = ?1", [&table_id]).map_err(db_err)?;
        tx.execute("DELETE FROM _taylor_automations WHERE table_id = ?1", [&table_id]).map_err(db_err)?;
        log_audit(&tx, &who, "table_delete", Some(&table_id), None, &json!({ "name": name }));
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        Ok(())
    })
}

#[tauri::command(async)]
pub fn tables_reorder(state: State<'_, Db>, ids: Vec<String>) -> Result<(), String> {
    with_base(&state, |b| {
        let tx = b.conn.transaction().map_err(db_err)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE _taylor_tables SET pos = ?1 WHERE id = ?2", rusqlite::params![i as i64, id])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        Ok(())
    })
}

/// Substitui, num JSON qualquer, valores string e CHAVES de objeto que sejam
/// ids antigos (usado ao duplicar tabela: configs de view e options de campo
/// referenciam ids de campo/tabela por valor ou por chave, ex.: widths).
fn remap_json_ids(v: &Json, map: &std::collections::HashMap<String, String>) -> Json {
    match v {
        Json::String(s) => map.get(s).map(|n| json!(n)).unwrap_or_else(|| v.clone()),
        Json::Array(items) => Json::Array(items.iter().map(|x| remap_json_ids(x, map)).collect()),
        Json::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, val) in o {
                let key = map.get(k).cloned().unwrap_or_else(|| k.clone());
                out.insert(key, remap_json_ids(val, map));
            }
            Json::Object(out)
        }
        _ => v.clone(),
    }
}

/// Duplica uma tabela inteira: metadados (campos e views ganham ids novos,
/// referências internas remapeadas) e dados (mesmos ids de registro, então
/// auto-relações continuam coerentes dentro da cópia).
#[tauri::command(async)]
pub fn table_duplicate(state: State<'_, Db>, table_id: String, actor: Option<String>) -> Result<String, String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let src_name: String = b
            .conn
            .query_row("SELECT name FROM _taylor_tables WHERE id = ?1", [&table_id], |r| r.get(0))
            .map_err(db_err)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let views: Vec<ViewMeta> = {
            let mut stmt = b
                .conn
                .prepare("SELECT id, name, kind, config, pos FROM _taylor_views WHERE table_id = ?1 ORDER BY pos, rowid")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([&table_id], |r| {
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
            rows.collect::<Result<_, _>>().map_err(db_err)?
        };

        let new_tid = new_id();
        let mut idmap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        idmap.insert(table_id.clone(), new_tid.clone());
        for f in &fields {
            idmap.insert(f.id.clone(), new_id());
        }

        let tx = b.conn.transaction().map_err(db_err)?;
        let pos: i64 = tx
            .query_row("SELECT COALESCE(MAX(pos), -1) + 1 FROM _taylor_tables", [], |r| r.get(0))
            .map_err(db_err)?;
        tx.execute(
            "INSERT INTO _taylor_tables(id, name, pos) VALUES (?1, ?2, ?3)",
            rusqlite::params![new_tid, format!("{} (cópia)", src_name), pos],
        )
        .map_err(db_err)?;
        for f in &fields {
            let new_fid = &idmap[&f.id];
            let options = remap_json_ids(&f.options, &idmap);
            tx.execute(
                "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![new_fid, new_tid, f.name, f.ftype, options.to_string(), f.pos],
            )
            .map_err(db_err)?;
        }
        for v in &views {
            let config = remap_json_ids(&v.config, &idmap);
            tx.execute(
                "INSERT INTO _taylor_views(id, table_id, name, kind, config, pos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![new_id(), new_tid, v.name, v.kind, config.to_string(), v.pos],
            )
            .map_err(db_err)?;
        }

        // tabela real: mesmas colunas (com ids novos) + cópia dos dados
        let col_fields: Vec<&FieldMeta> = fields.iter().filter(|f| has_column(&f.ftype)).collect();
        let new_cols = col_fields.iter().map(|f| format!("\"c_{}\"", idmap[&f.id])).collect::<Vec<_>>();
        let old_cols = col_fields.iter().map(|f| format!("\"c_{}\"", f.id)).collect::<Vec<_>>();
        tx.execute(
            &format!(
                "CREATE TABLE \"t_{}\" (id INTEGER PRIMARY KEY AUTOINCREMENT{})",
                new_tid,
                new_cols.iter().map(|c| format!(", {}", c)).collect::<String>()
            ),
            [],
        )
        .map_err(db_err)?;
        if !new_cols.is_empty() {
            tx.execute(
                &format!(
                    "INSERT INTO \"t_{}\" (id, {}) SELECT id, {} FROM \"t_{}\"",
                    new_tid,
                    new_cols.join(", "),
                    old_cols.join(", "),
                    table_id
                ),
                [],
            )
            .map_err(db_err)?;
        } else {
            tx.execute(
                &format!("INSERT INTO \"t_{}\" (id) SELECT id FROM \"t_{}\"", new_tid, table_id),
                [],
            )
            .map_err(db_err)?;
        }
        log_audit(&tx, &who, "table_duplicate", Some(&new_tid), None, &json!({ "from": table_id }));
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        Ok(new_tid)
    })
}

// ---------------------------------------------------------------------------
// Comandos: campos
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn field_create(
    state: State<'_, Db>,
    table_id: String,
    name: String,
    field_type: String,
    options: Json,
    actor: Option<String>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return err("nome de campo vazio");
    }
    if !FIELD_TYPES.contains(&field_type.as_str()) {
        return err(format!("tipo de campo desconhecido: '{}'", field_type));
    }
    let who = actor_name(&actor);
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
        log_audit(&tx, &who, "field_create", Some(&table_id), None, &json!({ "field": name, "type": field_type }));
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        Ok(fid)
    })
}

#[tauri::command(async)]
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
        b.bump_schema();
        Ok(())
    })
}

/// Muda o tipo de um campo convertendo os valores existentes (melhor esforço).
/// Como o SQLite não impõe tipo por coluna, não há rebuild de tabela: os dados
/// são convertidos linha a linha dentro de uma transação.
#[tauri::command(async)]
pub fn field_change_type(
    state: State<'_, Db>,
    field_id: String,
    field_type: String,
    options: Option<Json>,
    actor: Option<String>,
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
        log_audit(
            &tx,
            &actor_name(&actor),
            "field_change_type",
            Some(&table_id),
            None,
            &json!({ "field": field_id, "from": old_type, "to": field_type }),
        );
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        b.bump_data(&table_id);
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
        "text" | "long_text" | "url" | "email" | "phone" | "custom" => {
            // select armazenava o id da opção — sem acesso às opções antigas aqui,
            // o frontend manda converter via nome quando importa (aceito o id).
            json!(as_text())
        }
        "rating" => match v {
            Json::Number(_) => v.clone(),
            Json::String(s) => s.trim().replace(',', ".").parse::<f64>().map(|f| json!(f)).unwrap_or(Json::Null),
            Json::Bool(b) => json!(*b as i64),
            _ => Json::Null,
        },
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

#[tauri::command(async)]
pub fn field_delete(state: State<'_, Db>, field_id: String, actor: Option<String>) -> Result<(), String> {
    let who = actor_name(&actor);
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
        let fname: Option<String> = tx
            .query_row("SELECT name FROM _taylor_fields WHERE id = ?1", [&field_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        if has_column(&ftype) {
            tx.execute(&format!("ALTER TABLE \"t_{}\" DROP COLUMN \"c_{}\"", table_id, field_id), [])
                .map_err(db_err)?;
        }
        tx.execute("DELETE FROM _taylor_fields WHERE id = ?1", [&field_id]).map_err(db_err)?;
        log_audit(&tx, &who, "field_delete", Some(&table_id), None, &json!({ "field": fname, "type": ftype }));
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        b.bump_data(&table_id);
        Ok(())
    })
}

/// Duplica um campo (mesmo tipo/opções) logo após o original, copiando os dados.
#[tauri::command(async)]
pub fn field_duplicate(state: State<'_, Db>, field_id: String) -> Result<String, String> {
    with_base(&state, |b| {
        let (table_id, ftype, options) = field_meta(&b.conn, &field_id)?;
        let (name, pos): (String, i64) = b
            .conn
            .query_row("SELECT name, pos FROM _taylor_fields WHERE id = ?1", [&field_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(db_err)?;
        let new_fid = new_id();
        let tx = b.conn.transaction().map_err(db_err)?;
        tx.execute(
            "UPDATE _taylor_fields SET pos = pos + 1 WHERE table_id = ?1 AND pos > ?2",
            rusqlite::params![table_id, pos],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![new_fid, table_id, format!("{} (cópia)", name), ftype, options.to_string(), pos + 1],
        )
        .map_err(db_err)?;
        if has_column(&ftype) {
            tx.execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", table_id, new_fid), [])
                .map_err(db_err)?;
            tx.execute(
                &format!("UPDATE \"t_{}\" SET \"c_{}\" = \"c_{}\"", table_id, new_fid, field_id),
                [],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        b.bump_schema();
        b.bump_data(&table_id);
        Ok(new_fid)
    })
}

#[tauri::command(async)]
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
        b.bump_schema();
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

/// Constraints declarativas por campo (options): `unique`, `regex` (tipos
/// texto), `min`/`max` (número; data como ISO). Roda DENTRO da transação da
/// escrita — o servidor impõe pra todo cliente, não é só UI.
/// Vazio sempre passa (obrigatório é regra de formulário, não de banco — igual
/// ao Airtable: a grade cria linhas vazias por natureza).
fn enforce_constraints(
    conn: &Connection,
    table_id: &str,
    fields: &[FieldMeta],
    record_id: Option<i64>,
    map: &serde_json::Map<String, Json>,
) -> Result<(), String> {
    for (fid, v) in map {
        let Some(meta) = fields.iter().find(|m| &m.id == fid) else { continue };
        let opts = &meta.options;
        let empty = v.is_null()
            || v.as_str().map(|s| s.trim().is_empty()).unwrap_or(false)
            || v.as_array().map(|a| a.is_empty()).unwrap_or(false);
        if empty {
            continue;
        }
        if opts.get("unique").and_then(|x| x.as_bool()).unwrap_or(false) {
            let sqlv = cell_to_sql(&meta.ftype, opts, v)?;
            let col = format!("\"c_{}\"", fid);
            let n: i64 = match record_id {
                Some(id) => conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM \"t_{}\" WHERE {} = ?1 AND id != ?2", table_id, col),
                        rusqlite::params![sqlv, id],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?,
                None => conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM \"t_{}\" WHERE {} = ?1", table_id, col),
                        rusqlite::params![sqlv],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?,
            };
            if n > 0 {
                return err(format!("campo '{}': o valor precisa ser único e já existe", meta.name));
            }
        }
        if let Some(rx) = opts.get("regex").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
            if is_textlike(&meta.ftype) {
                let re = regex::Regex::new(rx)
                    .map_err(|e| format!("campo '{}': regex de validação inválida: {}", meta.name, e))?;
                let s = v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string());
                if !re.is_match(&s) {
                    return err(format!("campo '{}': valor não bate com o formato exigido", meta.name));
                }
            }
        }
        match meta.ftype.as_str() {
            "number" => {
                let n = match v {
                    Json::Number(n) => n.as_f64(),
                    Json::String(s) => s.trim().replace(',', ".").parse().ok(),
                    _ => None,
                };
                if let Some(n) = n {
                    if let Some(min) = opts.get("min").and_then(|x| x.as_f64()) {
                        if n < min {
                            return err(format!("campo '{}': mínimo é {}", meta.name, min));
                        }
                    }
                    if let Some(max) = opts.get("max").and_then(|x| x.as_f64()) {
                        if n > max {
                            return err(format!("campo '{}': máximo é {}", meta.name, max));
                        }
                    }
                }
            }
            "date" => {
                if let Some(s) = v.as_str() {
                    if let Some(min) = opts.get("min").and_then(|x| x.as_str()).filter(|m| !m.is_empty()) {
                        if s < min {
                            return err(format!("campo '{}': data mínima é {}", meta.name, min));
                        }
                    }
                    if let Some(max) = opts.get("max").and_then(|x| x.as_str()).filter(|m| !m.is_empty()) {
                        if s > max {
                            return err(format!("campo '{}': data máxima é {}", meta.name, max));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Células atuais de um registro como JSON (pro "antes" da auditoria).
fn cells_json_of(
    conn: &Connection,
    table_id: &str,
    fields: &[FieldMeta],
    record_id: i64,
    only: &serde_json::Map<String, Json>,
) -> Json {
    let mut out = serde_json::Map::new();
    for f in fields {
        if !has_column(&f.ftype) || !only.contains_key(&f.id) {
            continue;
        }
        let v = conn
            .query_row(
                &format!("SELECT \"c_{}\" FROM \"t_{}\" WHERE id = ?1", f.id, table_id),
                [record_id],
                |r| Ok(sql_to_json(&f.ftype, r.get_ref(0)?)),
            )
            .unwrap_or(Json::Null);
        out.insert(f.id.clone(), v);
    }
    Json::Object(out)
}

/// Campos de relação (em qualquer tabela) que apontam pra `target`:
/// (table_id, nome_da_tabela, campo).
fn link_fields_to(conn: &Connection, target: &str) -> Result<Vec<(String, String, FieldMeta)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.table_id, t.name, f.id, f.name, f.type, f.options, f.pos
             FROM _taylor_fields f JOIN _taylor_tables t ON t.id = f.table_id
             WHERE f.type = 'link'",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            let opts: String = r.get(5)?;
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                FieldMeta {
                    id: r.get(2)?,
                    name: r.get(3)?,
                    ftype: r.get(4)?,
                    options: serde_json::from_str(&opts).unwrap_or(json!({})),
                    pos: r.get(6)?,
                },
            ))
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for r in rows {
        let item = r.map_err(db_err)?;
        if item.2.options.get("tableId").and_then(|t| t.as_str()) == Some(target) {
            out.push(item);
        }
    }
    Ok(out)
}

/// Auditoria em lote fica resumida acima deste tamanho (import gigante não
/// incha a trilha com dezenas de milhares de linhas).
const AUDIT_BULK_CAP: usize = 200;

#[tauri::command(async)]
pub fn record_create(
    state: State<'_, Db>,
    table_id: String,
    cells: Json,
    actor: Option<String>,
) -> Result<i64, String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let map = cells.as_object().cloned().unwrap_or_default();
        let (cols, vals) = validated_cells(&fields, &map)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        enforce_constraints(&tx, &table_id, &fields, None, &map)?;
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
        let id = tx.last_insert_rowid();
        log_audit(&tx, &who, "create", Some(&table_id), Some(id), &json!({ "after": Json::Object(map) }));
        tx.commit().map_err(db_err)?;
        b.bump_data(&table_id);
        Ok(id)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordUpdate {
    pub id: i64,
    pub cells: Json,
}

#[tauri::command(async)]
pub fn records_update(
    state: State<'_, Db>,
    table_id: String,
    updates: Vec<RecordUpdate>,
    actor: Option<String>,
) -> Result<(), String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let summarize = updates.len() > AUDIT_BULK_CAP;
        let tx = b.conn.transaction().map_err(db_err)?;
        for u in &updates {
            let map = u.cells.as_object().cloned().unwrap_or_default();
            let (cols, mut vals) = validated_cells(&fields, &map)?;
            if cols.is_empty() {
                continue;
            }
            enforce_constraints(&tx, &table_id, &fields, Some(u.id), &map)?;
            let before = if summarize {
                Json::Null
            } else {
                cells_json_of(&tx, &table_id, &fields, u.id, &map)
            };
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
            if !summarize {
                log_audit(
                    &tx,
                    &who,
                    "update",
                    Some(&table_id),
                    Some(u.id),
                    &json!({ "before": before, "after": Json::Object(map) }),
                );
            }
        }
        if summarize {
            log_audit(&tx, &who, "update_bulk", Some(&table_id), None, &json!({ "count": updates.len() }));
        }
        tx.commit().map_err(db_err)?;
        b.bump_data(&table_id);
        Ok(())
    })
}

#[tauri::command(async)]
pub fn records_delete(
    state: State<'_, Db>,
    table_id: String,
    ids: Vec<i64>,
    actor: Option<String>,
) -> Result<(), String> {
    use std::collections::HashSet;
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        if ids.is_empty() {
            return Ok(());
        }
        let fields = table_fields(&b.conn, &table_id)?;
        let idset: HashSet<i64> = ids.iter().cloned().collect();
        let tx = b.conn.transaction().map_err(db_err)?;

        // Integridade referencial: quem aponta pros registros excluídos?
        // - campo com onDelete "restrict": exclusão é bloqueada com a origem;
        // - padrão ("unlink"): as referências são REMOVIDAS na mesma transação
        //   (nada de id órfão sobrando em outras tabelas).
        let mut touched: HashSet<String> = HashSet::new();
        let mut unlinked = 0usize;
        for (rt, rt_name, f) in link_fields_to(&tx, &table_id)? {
            let restrict = f.options.get("onDelete").and_then(|x| x.as_str()) == Some("restrict");
            let col = format!("\"c_{}\"", f.id);
            let sql = format!(
                "SELECT id, {} FROM \"t_{}\" WHERE {} IS NOT NULL AND {} != '[]' AND {} != ''",
                col, rt, col, col, col
            );
            let cells: Vec<(i64, String)> = {
                let mut stmt = tx.prepare(&sql).map_err(db_err)?;
                let rows = stmt
                    .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                    .map_err(db_err)?;
                rows.collect::<Result<_, _>>().map_err(db_err)?
            };
            for (rid, raw) in cells {
                // auto-relação: linha que também está sendo excluída não conta
                if rt == table_id && idset.contains(&rid) {
                    continue;
                }
                let Ok(Json::Array(arr)) = serde_json::from_str::<Json>(&raw) else { continue };
                let refs: Vec<i64> = arr.iter().filter_map(|x| x.as_i64()).collect();
                if !refs.iter().any(|r| idset.contains(r)) {
                    continue;
                }
                if restrict {
                    return err(format!(
                        "não dá pra excluir: o registro é referenciado por '{}' (campo '{}', registro {}) — o campo está configurado pra impedir",
                        rt_name, f.name, rid
                    ));
                }
                let kept: Vec<i64> = refs.into_iter().filter(|r| !idset.contains(r)).collect();
                tx.execute(
                    &format!("UPDATE \"t_{}\" SET {} = ?1 WHERE id = ?2", rt, col),
                    rusqlite::params![serde_json::to_string(&kept).unwrap_or_default(), rid],
                )
                .map_err(db_err)?;
                touched.insert(rt.clone());
                unlinked += 1;
            }
        }

        // auditoria: guarda as células de cada registro excluído (é o "antes")
        if ids.len() <= AUDIT_BULK_CAP {
            for id in &ids {
                let all: serde_json::Map<String, Json> =
                    fields.iter().filter(|f| has_column(&f.ftype)).map(|f| (f.id.clone(), Json::Null)).collect();
                let cells = cells_json_of(&tx, &table_id, &fields, *id, &all);
                log_audit(&tx, &who, "delete", Some(&table_id), Some(*id), &json!({ "before": cells, "unlinked": unlinked }));
            }
        } else {
            log_audit(&tx, &who, "delete_bulk", Some(&table_id), None, &json!({ "count": ids.len(), "unlinked": unlinked }));
        }

        let marks = vec!["?"; ids.len()].join(",");
        tx.execute(
            &format!("DELETE FROM \"t_{}\" WHERE id IN ({})", table_id, marks),
            rusqlite::params_from_iter(ids.iter()),
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        b.bump_data(&table_id);
        for t in touched {
            b.bump_data(&t);
        }
        Ok(())
    })
}

/// Insere em lote (uma transação) e devolve os ids criados, na ordem — o
/// frontend precisa deles pro undo/redo e pra abrir o registro recém-criado.
#[tauri::command(async)]
pub fn records_insert_bulk(
    state: State<'_, Db>,
    table_id: String,
    rows: Vec<Json>,
    actor: Option<String>,
) -> Result<Vec<i64>, String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let summarize = rows.len() > AUDIT_BULK_CAP;
        let tx = b.conn.transaction().map_err(db_err)?;
        let mut ids = Vec::with_capacity(rows.len());
        for row in &rows {
            let map = row.as_object().cloned().unwrap_or_default();
            let (cols, vals) = validated_cells(&fields, &map)?;
            enforce_constraints(&tx, &table_id, &fields, None, &map)?;
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
            let id = tx.last_insert_rowid();
            if !summarize {
                log_audit(&tx, &who, "create", Some(&table_id), Some(id), &json!({ "after": Json::Object(map) }));
            }
            ids.push(id);
        }
        if summarize {
            log_audit(&tx, &who, "create_bulk", Some(&table_id), None, &json!({ "count": rows.len() }));
        }
        tx.commit().map_err(db_err)?;
        b.bump_data(&table_id);
        Ok(ids)
    })
}

/// Restaura registros excluídos COM os ids originais (undo de exclusão).
/// Seguro porque a tabela usa AUTOINCREMENT: um id excluído nunca é reciclado,
/// então re-inserir com id explícito não colide com registros novos. Assim as
/// relações (arrays de ids em campos link) continuam apontando certo.
#[tauri::command(async)]
pub fn records_restore(
    state: State<'_, Db>,
    table_id: String,
    rows: Vec<Json>,
    actor: Option<String>,
) -> Result<(), String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let tx = b.conn.transaction().map_err(db_err)?;
        for row in &rows {
            let id = row.get("id").and_then(|v| v.as_i64()).ok_or("restore sem id")?;
            let map = row
                .get("cells")
                .and_then(|c| c.as_object())
                .cloned()
                .unwrap_or_default();
            // restore é undo: sem constraints (o dado é o que era antes)
            let (mut cols, mut vals) = validated_cells(&fields, &map)?;
            cols.insert(0, "id".into());
            vals.insert(0, SqlValue::Integer(id));
            let marks = vec!["?"; cols.len()].join(",");
            tx.execute(
                &format!("INSERT INTO \"t_{}\" ({}) VALUES ({})", table_id, cols.join(","), marks),
                rusqlite::params_from_iter(vals.iter()),
            )
            .map_err(db_err)?;
        }
        log_audit(&tx, &who, "restore", Some(&table_id), None, &json!({ "count": rows.len() }));
        tx.commit().map_err(db_err)?;
        b.bump_data(&table_id);
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Agregações no SQL (rodapé da grade e relatórios): O(1) de memória no front,
// vale mesmo com a tabela só parcialmente carregada.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggSpec {
    pub field_id: String,
    pub kind: String, // filled | sum | avg | min | max
}

#[tauri::command(async)]
pub fn records_aggregate(
    state: State<'_, Db>,
    table_id: String,
    filters: Option<Vec<Filter>>,
    search: Option<String>,
    aggs: Vec<AggSpec>,
) -> Result<Json, String> {
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let fields = table_fields(&b.conn, &table_id)?;
        let (where_sql, params) = build_where(&filters.unwrap_or_default(), &search, &fields)?;
        let mut selects: Vec<String> = Vec::new();
        let mut order: Vec<&AggSpec> = Vec::new();
        for a in &aggs {
            let meta = fields.iter().find(|m| m.id == a.field_id);
            let Some(meta) = meta else { continue };
            if !has_column(&meta.ftype) {
                continue;
            }
            let col = format!("\"c_{}\"", meta.id);
            let expr = match a.kind.as_str() {
                "filled" => format!(
                    "SUM(CASE WHEN {0} IS NOT NULL AND {0} != '' AND {0} != '[]' THEN 1 ELSE 0 END)",
                    col
                ),
                "sum" => format!("SUM(CAST({} AS REAL))", col),
                "avg" => format!("AVG(CAST({} AS REAL))", col),
                "min" => format!("MIN(CAST({} AS REAL))", col),
                "max" => format!("MAX(CAST({} AS REAL))", col),
                _ => continue,
            };
            selects.push(expr);
            order.push(a);
        }
        if selects.is_empty() {
            return Ok(json!({}));
        }
        let sql = format!("SELECT {} FROM \"t_{}\"{}", selects.join(", "), table_id, where_sql);
        let out = b
            .conn
            .query_row(&sql, rusqlite::params_from_iter(params.iter()), |r| {
                let mut m = serde_json::Map::new();
                for (i, a) in order.iter().enumerate() {
                    let v: Option<f64> = r.get(i).ok();
                    m.insert(
                        format!("{}:{}", a.field_id, a.kind),
                        v.map(|f| json!(f)).unwrap_or(Json::Null),
                    );
                }
                Ok(Json::Object(m))
            })
            .map_err(db_err)?;
        Ok(out)
    })
}

// ---------------------------------------------------------------------------
// Auditoria: consulta (a escrita acontece dentro das mutações)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub ts: String,
    pub actor: String,
    pub action: String,
    pub table_id: Option<String>,
    pub record_id: Option<i64>,
    pub detail: Json,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    pub total: i64,
}

#[tauri::command(async)]
pub fn audit_query(
    state: State<'_, Db>,
    table_id: Option<String>,
    record_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<AuditPage, String> {
    with_base(&state, |b| {
        let mut where_sql = String::new();
        let mut params: Vec<SqlValue> = Vec::new();
        if let Some(t) = &table_id {
            where_sql.push_str(" WHERE table_id = ?");
            params.push(SqlValue::Text(t.clone()));
            if let Some(r) = record_id {
                where_sql.push_str(" AND record_id = ?");
                params.push(SqlValue::Integer(r));
            }
        }
        let total: i64 = b
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM _taylor_audit{}", where_sql),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let sql = format!(
            "SELECT id, ts, actor, action, table_id, record_id, detail FROM _taylor_audit{} ORDER BY id DESC LIMIT {} OFFSET {}",
            where_sql,
            limit.unwrap_or(100).clamp(1, 500),
            offset.unwrap_or(0).max(0)
        );
        let mut stmt = b.conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                let detail: String = r.get(6)?;
                Ok(AuditEntry {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    actor: r.get(2)?,
                    action: r.get(3)?,
                    table_id: r.get(4)?,
                    record_id: r.get(5)?,
                    detail: serde_json::from_str(&detail).unwrap_or(json!({})),
                })
            })
            .map_err(db_err)?;
        let entries = rows.collect::<Result<_, _>>().map_err(db_err)?;
        Ok(AuditPage { entries, total })
    })
}

// ---------------------------------------------------------------------------
// Comandos: views
// ---------------------------------------------------------------------------

#[tauri::command(async)]
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
        b.bump_schema();
        Ok(vid)
    })
}

#[tauri::command(async)]
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
        b.bump_schema();
        Ok(())
    })
}

/// Duplica uma view (mesma configuração) no fim da lista.
#[tauri::command(async)]
pub fn view_duplicate(state: State<'_, Db>, view_id: String) -> Result<String, String> {
    with_base(&state, |b| {
        let row: Option<(String, String, String, String)> = b
            .conn
            .query_row(
                "SELECT table_id, name, kind, config FROM _taylor_views WHERE id = ?1",
                [&view_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(db_err)?;
        let (table_id, name, kind, config) = row.ok_or("view não encontrada")?;
        let new_vid = new_id();
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
                rusqlite::params![new_vid, table_id, format!("{} (cópia)", name), kind, config, pos],
            )
            .map_err(db_err)?;
        b.bump_schema();
        Ok(new_vid)
    })
}

#[tauri::command(async)]
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
        b.bump_schema();
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Automações (regras por tabela; a execução acontece no frontend de quem
// fez a edição — ver src/lib/automations.ts). Config é JSON opaco pro Rust.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationMeta {
    pub id: String,
    pub table_id: String,
    pub config: Json,
    pub pos: i64,
}

#[tauri::command(async)]
pub fn automations_list(state: State<'_, Db>, table_id: Option<String>) -> Result<Vec<AutomationMeta>, String> {
    with_base(&state, |b| {
        let (sql, param): (&str, Vec<String>) = match &table_id {
            Some(t) => (
                "SELECT id, table_id, config, pos FROM _taylor_automations WHERE table_id = ?1 ORDER BY pos, rowid",
                vec![t.clone()],
            ),
            None => ("SELECT id, table_id, config, pos FROM _taylor_automations ORDER BY pos, rowid", vec![]),
        };
        let mut stmt = b.conn.prepare(sql).map_err(db_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(param.iter()), |r| {
                let cfg: String = r.get(2)?;
                Ok(AutomationMeta {
                    id: r.get(0)?,
                    table_id: r.get(1)?,
                    config: serde_json::from_str(&cfg).unwrap_or(json!({})),
                    pos: r.get(3)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    })
}

#[tauri::command(async)]
pub fn automation_save(
    state: State<'_, Db>,
    id: Option<String>,
    table_id: String,
    config: Json,
    actor: Option<String>,
) -> Result<String, String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        table_exists(&b.conn, &table_id)?;
        let aid = match id {
            Some(aid) => {
                b.conn
                    .execute(
                        "UPDATE _taylor_automations SET config = ?1 WHERE id = ?2",
                        rusqlite::params![config.to_string(), aid],
                    )
                    .map_err(db_err)?;
                aid
            }
            None => {
                let aid = new_id();
                let pos: i64 = b
                    .conn
                    .query_row(
                        "SELECT COALESCE(MAX(pos), -1) + 1 FROM _taylor_automations WHERE table_id = ?1",
                        [&table_id],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?;
                b.conn
                    .execute(
                        "INSERT INTO _taylor_automations(id, table_id, config, pos) VALUES (?1,?2,?3,?4)",
                        rusqlite::params![aid, table_id, config.to_string(), pos],
                    )
                    .map_err(db_err)?;
                aid
            }
        };
        log_audit(&b.conn, &who, "automation_save", Some(&table_id), None, &json!({ "id": aid }));
        b.bump_schema();
        Ok(aid)
    })
}

#[tauri::command(async)]
pub fn automation_delete(state: State<'_, Db>, id: String, actor: Option<String>) -> Result<(), String> {
    let who = actor_name(&actor);
    with_base(&state, |b| {
        b.conn.execute("DELETE FROM _taylor_automations WHERE id = ?1", [&id]).map_err(db_err)?;
        log_audit(&b.conn, &who, "automation_delete", None, None, &json!({ "id": id }));
        b.bump_schema();
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

#[tauri::command(async)]
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

/// Sobe um anexo por conteúdo (cliente remoto: o arquivo é local NELE, então
/// os bytes chegam em base64 — o caminho nunca atravessa a rede).
#[tauri::command(async)]
pub fn attachment_upload(state: State<'_, Db>, name: String, base64_data: String) -> Result<AttachmentMeta, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 inválido: {}", e))?;
    with_base(&state, |b| {
        let id = new_id();
        let mime = guess_mime(&name).to_string();
        let size = data.len() as i64;
        b.conn
            .execute(
                "INSERT INTO _taylor_blobs(id, name, mime, size, data) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, name, mime, size, data],
            )
            .map_err(db_err)?;
        Ok(AttachmentMeta { id, name, mime, size })
    })
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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
#[tauri::command(async)]
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
        Base::new(conn, PathBuf::from("test.tbase"))
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
    fn valida_tipos_novos() {
        // rating: arredonda, limita ao max e 0 vira NULL
        assert!(matches!(cell_to_sql("rating", &json!({}), &json!(3)).unwrap(), SqlValue::Integer(3)));
        assert!(matches!(cell_to_sql("rating", &json!({}), &json!(9)).unwrap(), SqlValue::Integer(5)));
        assert!(matches!(cell_to_sql("rating", &json!({"ratingMax": 10}), &json!(9)).unwrap(), SqlValue::Integer(9)));
        assert!(matches!(cell_to_sql("rating", &json!({}), &json!(0)).unwrap(), SqlValue::Null));
        assert!(matches!(cell_to_sql("rating", &json!({}), &json!("4,4")).unwrap(), SqlValue::Integer(4)));
        // url/email/phone armazenam texto
        assert!(matches!(cell_to_sql("url", &json!({}), &json!("https://x.dev")).unwrap(), SqlValue::Text(_)));
        assert!(matches!(cell_to_sql("email", &json!({}), &json!("a@b.c")).unwrap(), SqlValue::Text(_)));
        // computados são somente leitura e não têm coluna
        assert!(cell_to_sql("lookup", &json!({}), &json!("x")).is_err());
        assert!(cell_to_sql("rollup", &json!({}), &json!("x")).is_err());
        assert!(!has_column("lookup") && !has_column("rollup") && !has_column("formula"));
        assert!(has_column("rating") && has_column("url"));
    }

    #[test]
    fn tipo_custom_e_texto_no_banco() {
        // extensões nunca mudam a camada SQL: custom é TEXT com coluna real
        assert!(has_column("custom"));
        assert!(is_textlike("custom"));
        assert!(matches!(cell_to_sql("custom", &json!({}), &json!("123.456.789-09")).unwrap(), SqlValue::Text(_)));
        assert!(matches!(cell_to_sql("custom", &json!({}), &json!(42)).unwrap(), SqlValue::Text(_)));
        // busca e ordenação tratam custom como texto
        let fields = vec![FieldMeta { id: "x".into(), name: "CPF".into(), ftype: "custom".into(), options: json!({}), pos: 0 }];
        let (w, p) = build_where(&[], &Some("789".into()), &fields).unwrap();
        assert!(w.contains("LIKE") && p.len() == 1);
        assert!(build_order(&[Sort { field_id: "x".into(), desc: false }], &fields).unwrap().contains("NOCASE"));
    }

    #[test]
    fn duplica_tabela_remapeando_ids() {
        let b = memory_base();
        let s = read_schema(&b.conn, &b.path).unwrap();
        let t = &s.tables[0];
        let f0 = t.fields[0].id.clone();
        // uma view com config que referencia o campo por valor e por chave
        b.conn
            .execute(
                "UPDATE _taylor_views SET config = ?1 WHERE table_id = ?2",
                rusqlite::params![
                    json!({"hiddenFields": [f0], "widths": {f0.clone(): 240}}).to_string(),
                    t.id
                ],
            )
            .unwrap();
        // um registro
        b.conn
            .execute(&format!("INSERT INTO \"t_{}\" (\"c_{}\") VALUES ('Oi')", t.id, f0), [])
            .unwrap();

        // duplica manualmente (mesma lógica do comando, sem State)
        let fields = table_fields(&b.conn, &t.id).unwrap();
        let mut idmap = std::collections::HashMap::new();
        idmap.insert(t.id.clone(), "novaT".to_string());
        for f in &fields {
            idmap.insert(f.id.clone(), format!("n{}", f.id));
        }
        let cfg: String = b
            .conn
            .query_row("SELECT config FROM _taylor_views WHERE table_id = ?1", [&t.id], |r| r.get(0))
            .unwrap();
        let cfg: Json = serde_json::from_str(&cfg).unwrap();
        let remapped = remap_json_ids(&cfg, &idmap);
        assert_eq!(remapped["hiddenFields"][0], json!(format!("n{}", f0)));
        assert_eq!(remapped["widths"][&format!("n{}", f0)], json!(240));
        assert!(remapped["widths"].get(&f0).is_none());
    }

    /// insere um registro validando+constraints, como os comandos fazem.
    fn insert_row(b: &Base, table_id: &str, map: serde_json::Map<String, Json>) -> Result<i64, String> {
        let fields = table_fields(&b.conn, table_id).unwrap();
        let (cols, vals) = validated_cells(&fields, &map)?;
        enforce_constraints(&b.conn, table_id, &fields, None, &map)?;
        let marks = vec!["?"; cols.len()].join(",");
        b.conn
            .execute(
                &format!("INSERT INTO \"t_{}\" ({}) VALUES ({})", table_id, cols.join(","), marks),
                rusqlite::params_from_iter(vals.iter()),
            )
            .map_err(db_err)?;
        Ok(b.conn.last_insert_rowid())
    }

    #[test]
    fn constraint_unico_bloqueia_repetido() {
        let b = memory_base();
        let s = read_schema(&b.conn, &b.path).unwrap();
        let f0 = s.tables[0].fields[0].id.clone();
        // marca o campo primário como único
        b.conn
            .execute(
                "UPDATE _taylor_fields SET options = ?1 WHERE id = ?2",
                rusqlite::params![json!({"unique": true}).to_string(), f0],
            )
            .unwrap();
        let mk = |v: &str| -> serde_json::Map<String, Json> { [(f0.clone(), json!(v))].into_iter().collect() };
        assert!(insert_row(&b, &s.tables[0].id, mk("Ana")).is_ok());
        assert!(insert_row(&b, &s.tables[0].id, mk("Ana")).is_err()); // duplicado
        assert!(insert_row(&b, &s.tables[0].id, mk("Bia")).is_ok());
        // vazio nunca colide
        assert!(insert_row(&b, &s.tables[0].id, mk("")).is_ok());
        assert!(insert_row(&b, &s.tables[0].id, mk("")).is_ok());
    }

    #[test]
    fn constraint_regex_e_faixa_numerica() {
        let b = memory_base();
        let s = read_schema(&b.conn, &b.path).unwrap();
        let tid = s.tables[0].id.clone();
        // campo número com min/max
        let num = new_id();
        b.conn
            .execute(
                "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1,?2,'Nota','number',?3,5)",
                rusqlite::params![num, tid, json!({"min": 0.0, "max": 10.0}).to_string()],
            )
            .unwrap();
        b.conn.execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", tid, num), []).unwrap();
        let mk = |v: f64| -> serde_json::Map<String, Json> { [(num.clone(), json!(v))].into_iter().collect() };
        assert!(insert_row(&b, &tid, mk(7.0)).is_ok());
        assert!(insert_row(&b, &tid, mk(-1.0)).is_err());
        assert!(insert_row(&b, &tid, mk(11.0)).is_err());
    }

    #[test]
    fn agregacao_no_sql() {
        let b = memory_base();
        let s = read_schema(&b.conn, &b.path).unwrap();
        let tid = s.tables[0].id.clone();
        let num = new_id();
        b.conn
            .execute(
                "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1,?2,'Valor','number','{}',5)",
                rusqlite::params![num, tid],
            )
            .unwrap();
        b.conn.execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", tid, num), []).unwrap();
        for v in [10.0, 20.0, 30.0] {
            insert_row(&b, &tid, [(num.clone(), json!(v))].into_iter().collect()).unwrap();
        }
        let fields = table_fields(&b.conn, &tid).unwrap();
        let (w, p) = build_where(&[], &None, &fields).unwrap();
        let sql = format!("SELECT SUM(CAST(\"c_{}\" AS REAL)), AVG(CAST(\"c_{}\" AS REAL)) FROM \"t_{}\"{}", num, num, tid, w);
        let (sum, avg): (f64, f64) = b
            .conn
            .query_row(&sql, rusqlite::params_from_iter(p.iter()), |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(sum, 60.0);
        assert_eq!(avg, 20.0);
    }

    #[test]
    fn escala_100k_query_e_agregacao() {
        // insere 100k linhas e confere que consulta paginada + agregação no SQL
        // respondem rápido (o teste passa; o tempo aparece com `cargo test -- --nocapture`)
        let b = memory_base();
        let s = read_schema(&b.conn, &b.path).unwrap();
        let tid = s.tables[0].id.clone();
        let name_f = s.tables[0].fields[0].id.clone();
        let val = new_id();
        b.conn
            .execute(
                "INSERT INTO _taylor_fields(id, table_id, name, type, options, pos) VALUES (?1,?2,'Valor','number','{}',5)",
                rusqlite::params![val, tid],
            )
            .unwrap();
        b.conn.execute(&format!("ALTER TABLE \"t_{}\" ADD COLUMN \"c_{}\"", tid, val), []).unwrap();

        let t0 = std::time::Instant::now();
        {
            let tx = b.conn.unchecked_transaction().unwrap();
            let sql = format!("INSERT INTO \"t_{}\" (\"c_{}\", \"c_{}\") VALUES (?1, ?2)", tid, name_f, val);
            let mut stmt = tx.prepare(&sql).unwrap();
            for i in 0..100_000i64 {
                stmt.execute(rusqlite::params![format!("Item {}", i), (i % 1000) as f64]).unwrap();
            }
            drop(stmt);
            tx.commit().unwrap();
        }
        let insert_ms = t0.elapsed().as_millis();

        let fields = table_fields(&b.conn, &tid).unwrap();
        // conta total
        let total: i64 = b.conn.query_row(&format!("SELECT COUNT(*) FROM \"t_{}\"", tid), [], |r| r.get(0)).unwrap();
        assert_eq!(total, 100_000);

        // 1ª página (1000) com ordenação por número
        let t1 = std::time::Instant::now();
        let order = build_order(&[Sort { field_id: val.clone(), desc: true }], &fields).unwrap();
        let sql = format!("SELECT {} FROM \"t_{}\"{} LIMIT 1000", select_cols(&fields), tid, order);
        let page: Vec<Json> =
            b.conn.prepare(&sql).unwrap().query_map([], |r| row_to_json(&fields, r)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(page.len(), 1000);
        let page_ms = t1.elapsed().as_millis();

        // agregação (soma/média) sobre tudo, no SQL
        let t2 = std::time::Instant::now();
        let (sum, avg): (f64, f64) = b
            .conn
            .query_row(
                &format!("SELECT SUM(CAST(\"c_{}\" AS REAL)), AVG(CAST(\"c_{}\" AS REAL)) FROM \"t_{}\"", val, val, tid),
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let agg_ms = t2.elapsed().as_millis();
        // 0..999 repetido 100x → média 499.5
        assert!((avg - 499.5).abs() < 0.01);
        assert!(sum > 0.0);

        println!(
            "100k: insert {}ms, página {}ms, agregação {}ms",
            insert_ms, page_ms, agg_ms
        );
        // sanidade de performance: página e agregação bem abaixo de 1s
        assert!(page_ms < 2000, "página lenta: {}ms", page_ms);
        assert!(agg_ms < 2000, "agregação lenta: {}ms", agg_ms);
    }

    #[test]
    fn login_argon2_roundtrip() {
        let b = memory_base();
        let (salt, hash) = hash_password(&b.conn, "segredo123").unwrap();
        let uid = new_id();
        b.conn
            .execute(
                "INSERT INTO _taylor_users(id, name, role, salt, hash) VALUES (?1,'admin','admin',?2,?3)",
                rusqlite::params![uid, salt, hash],
            )
            .unwrap();
        // confere via a mesma derivação usada em verify_login
        use argon2::Argon2;
        let mut out = [0u8; 32];
        Argon2::default()
            .hash_password_into("segredo123".as_bytes(), &hex_to_bytes(&salt), &mut out)
            .unwrap();
        assert_eq!(hex_of(&out), hash);
        let mut wrong = [0u8; 32];
        Argon2::default()
            .hash_password_into("errada".as_bytes(), &hex_to_bytes(&salt), &mut wrong)
            .unwrap();
        assert_ne!(hex_of(&wrong), hash);
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
