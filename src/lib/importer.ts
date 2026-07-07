// Import CSV/XLSX -> nova tabela tipada (inferência de tipo por coluna) e
// export da tabela atual. Regra da suíte: parse/geração de arquivo no webview
// (SheetJS); Rust só move bytes.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as XLSX from "xlsx";
import * as api from "./backend";
import type { CellValue, Field, FieldType, RecordRow, Table } from "./types";

const readFileB64 = (path: string) => invoke<string>("read_file_base64", { path });
const writeFileB64 = (path: string, base64Data: string) => invoke<void>("write_file_base64", { path, base64Data });

// ---------------------------------------------------------------------------
// inferência de tipo
// ---------------------------------------------------------------------------

const DATE_BR = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const DATE_ISO = /^\d{4}-\d{2}-\d{2}/;
const BOOL_SET = new Set(["true", "false", "sim", "não", "nao", "yes", "no", "x", ""]);

export function inferType(values: string[]): FieldType {
  const nonEmpty = values.filter((v) => v.trim() !== "");
  if (!nonEmpty.length) return "text";
  // data antes de número: "2026-01-02" também parsearia como número
  if (nonEmpty.every((v) => DATE_ISO.test(v.trim()) || DATE_BR.test(v.trim()))) return "date";
  const isNum = (v: string) => /^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(v.trim()) || !isNaN(parseFloat(v.trim().replace(",", ".")));
  if (nonEmpty.every((v) => isNum(v) && v.trim() !== "" && /^[-\d.,\s]+$/.test(v))) return "number";
  if (values.every((v) => BOOL_SET.has(v.trim().toLowerCase()))) return "checkbox";
  // poucas opções repetidas -> select
  const distinct = new Set(nonEmpty.map((v) => v.trim()));
  if (distinct.size <= 12 && nonEmpty.length >= distinct.size * 2 && nonEmpty.length > 8) return "select";
  if (nonEmpty.some((v) => v.length > 120 || v.includes("\n"))) return "long_text";
  return "text";
}

export function convertRaw(type: FieldType, raw: string): CellValue {
  const v = raw.trim();
  if (v === "") return null;
  switch (type) {
    case "number": {
      const n = parseFloat(v.replace(/\./g, "").replace(",", "."));
      const plain = parseFloat(v.replace(",", "."));
      // "1.234,56" (pt-BR) vs "1234.56": se só tem um separador, confia no parse direto
      return isNaN(plain) ? (isNaN(n) ? null : n) : plain;
    }
    case "date": {
      const br = v.match(DATE_BR);
      if (br) return `${br[3]}-${br[2]}-${br[1]}`;
      return DATE_ISO.test(v) ? v.slice(0, 16) : null;
    }
    case "checkbox":
      return ["true", "sim", "yes", "x", "1"].includes(v.toLowerCase());
    default:
      return raw;
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

interface StoreLike {
  refreshSchema(): Promise<void>;
  setActiveTable(id: string): void;
  setError(e: string | null): void;
}

export async function importFile(store: StoreLike): Promise<void> {
  try {
    const picked = await openDialog({
      title: "Importar planilha",
      filters: [{ name: "Planilhas", extensions: ["csv", "xlsx", "xls"] }],
      multiple: false,
    });
    if (!picked || Array.isArray(picked)) return;
    const b64 = await readFileB64(picked);
    const wb = XLSX.read(b64, { type: "base64", raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
    if (!grid.length) throw new Error("arquivo vazio");

    const headers = grid[0].map((h, i) => String(h).trim() || `Coluna ${i + 1}`);
    const body = grid.slice(1).filter((row) => row.some((c) => String(c).trim() !== ""));

    // inferir tipo por coluna
    const types: FieldType[] = headers.map((_, c) => inferType(body.map((row) => String(row[c] ?? ""))));

    // nome da tabela = nome do arquivo
    const fname = picked.replace(/\\/g, "/").split("/").pop() ?? "Importada";
    const tableName = fname.replace(/\.(csv|xlsx|xls)$/i, "");

    const tableId = await api.tableCreate(tableName);
    // a tabela nova nasce com "Nome"/"Notas" — troca pelos campos do arquivo
    const schema = await api.baseSchema();
    const table = schema.tables.find((t) => t.id === tableId)!;
    const defaultFieldIds = table.fields.map((f) => f.id);

    const fieldIds: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      let options: object = {};
      if (types[c] === "select") {
        const distinct = Array.from(new Set(body.map((r) => String(r[c] ?? "").trim()).filter(Boolean)));
        options = {
          choices: distinct.map((name, i) => ({ id: `imp${c}_${i}`, name, color: "" })),
        };
      }
      fieldIds.push(await api.fieldCreate(tableId, headers[c], types[c], options));
    }
    for (const fid of defaultFieldIds) await api.fieldDelete(fid);

    // linhas
    const choiceMaps: (Map<string, string> | null)[] = headers.map((_, c) => {
      if (types[c] !== "select") return null;
      const m = new Map<string, string>();
      const distinct = Array.from(new Set(body.map((r) => String(r[c] ?? "").trim()).filter(Boolean)));
      distinct.forEach((name, i) => m.set(name, `imp${c}_${i}`));
      return m;
    });
    const rows = body.map((row) => {
      const cells: Record<string, CellValue> = {};
      for (let c = 0; c < headers.length; c++) {
        const raw = String(row[c] ?? "");
        if (types[c] === "select") {
          const id = choiceMaps[c]?.get(raw.trim());
          cells[fieldIds[c]] = id ?? null;
        } else {
          cells[fieldIds[c]] = convertRaw(types[c], raw);
        }
      }
      return cells;
    });
    if (rows.length) await api.recordsInsertBulk(tableId, rows);

    await store.refreshSchema();
    store.setActiveTable(tableId);
  } catch (e) {
    store.setError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// import com upsert (atualiza a tabela ATIVA casando por um campo-chave)
// ---------------------------------------------------------------------------

export interface SheetData {
  path: string;
  headers: string[];
  body: string[][];
}

/** Abre o diálogo, lê e faz o parse da planilha (sem tocar na base). */
export async function pickSheet(): Promise<SheetData | null> {
  const picked = await openDialog({
    title: "Importar planilha",
    filters: [{ name: "Planilhas", extensions: ["csv", "xlsx", "xls"] }],
    multiple: false,
  });
  if (!picked || Array.isArray(picked)) return null;
  const b64 = await readFileB64(picked);
  const wb = XLSX.read(b64, { type: "base64", raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  if (!grid.length) throw new Error("arquivo vazio");
  const headers = grid[0].map((h, i) => String(h).trim() || `Coluna ${i + 1}`);
  const body = grid.slice(1).filter((row) => row.some((c) => String(c).trim() !== ""));
  return { path: picked, headers, body };
}

/** Puxa todos os registros de uma tabela (para montar o índice do upsert). */
async function fetchAllRows(tableId: string): Promise<RecordRow[]> {
  const out: RecordRow[] = [];
  for (;;) {
    const res = await api.recordsQuery(tableId, { limit: 2000, offset: out.length });
    out.push(...res.rows);
    if (out.length >= res.total || !res.rows.length) break;
  }
  return out;
}

export interface UpsertResult {
  updated: number;
  created: number;
  skipped: number;
}

/**
 * Importa `sheet` para dentro de `table`, casando cada linha por `keyFieldId`
 * (compara pelo texto exibido). Colunas são mapeadas por NOME de cabeçalho →
 * campo existente (case-insensitive); colunas sem par são ignoradas. Campos
 * computados nunca são escritos. Opções de select ausentes são criadas.
 */
export async function upsertImport(
  store: { updateRecordsBulk(u: { id: number; cells: Record<string, CellValue> }[]): Promise<void>; createRecordsBulk(rows: Record<string, CellValue>[]): Promise<number[] | null>; refreshRows(): Promise<void> },
  table: Table,
  sheet: SheetData,
  keyFieldId: string
): Promise<UpsertResult> {
  const norm = (s: string) => s.trim().toLowerCase();
  // cabeçalho → campo da tabela
  const colField = sheet.headers.map((h) => table.fields.find((f) => norm(f.name) === norm(h)));
  const keyField = table.fields.find((f) => f.id === keyFieldId);
  if (!keyField) throw new Error("campo-chave inválido");
  const keyCol = colField.findIndex((f) => f?.id === keyFieldId);
  if (keyCol < 0) throw new Error(`a planilha não tem uma coluna chamada "${keyField.name}" pra casar`);

  // índice das linhas existentes por valor-chave (texto exibido, normalizado)
  const existing = await fetchAllRows(table.id);
  const keyText = (cells: Record<string, CellValue>): string => {
    const v = cells[keyFieldId];
    if (v == null) return "";
    if (keyField.type === "select") {
      return norm((keyField.options.choices ?? []).find((c) => c.id === v)?.name ?? "");
    }
    return norm(String(v));
  };
  const index = new Map<string, number>();
  for (const r of existing) {
    const k = keyText(r.cells);
    if (k) index.set(k, r.id);
  }

  // pré-cria opções de select que faltam (uma atualização por campo)
  for (let c = 0; c < sheet.headers.length; c++) {
    const f = colField[c];
    if (!f || (f.type !== "select" && f.type !== "multi_select")) continue;
    const values = sheet.body.map((row) => String(row[c] ?? "")).filter(Boolean);
    const have = new Set((f.options.choices ?? []).map((x) => norm(x.name)));
    const missing = Array.from(new Set(values.map((v) => v.trim()))).filter((v) => v && !have.has(norm(v)));
    if (missing.length) {
      const choices = [
        ...(f.options.choices ?? []),
        ...missing.map((name, i) => ({ id: `imp${Date.now().toString(36)}${c}_${i}`, name, color: "" })),
      ];
      await api.fieldUpdate(f.id, undefined, { ...f.options, choices });
      f.options = { ...f.options, choices };
    }
  }

  const toCells = (row: string[]): Record<string, CellValue> => {
    const cells: Record<string, CellValue> = {};
    for (let c = 0; c < sheet.headers.length; c++) {
      const f = colField[c];
      if (!f || f.type === "formula" || f.type === "lookup" || f.type === "rollup" || f.type === "link" || f.type === "attachment") continue;
      const raw = String(row[c] ?? "");
      if (f.type === "select") {
        cells[f.id] = (f.options.choices ?? []).find((x) => norm(x.name) === norm(raw))?.id ?? null;
      } else if (f.type === "multi_select") {
        const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
        cells[f.id] = names.map((n) => (f.options.choices ?? []).find((x) => norm(x.name) === norm(n))?.id).filter((x): x is string => !!x);
      } else {
        cells[f.id] = convertRaw(f.type, raw);
      }
    }
    return cells;
  };

  const updates: { id: number; cells: Record<string, CellValue> }[] = [];
  const creates: Record<string, CellValue>[] = [];
  let skipped = 0;
  for (const row of sheet.body) {
    const k = norm(String(row[keyCol] ?? ""));
    if (!k) {
      skipped++;
      continue;
    }
    const cells = toCells(row);
    const hit = index.get(k);
    if (hit != null) updates.push({ id: hit, cells });
    else creates.push(cells);
  }

  if (updates.length) await store.updateRecordsBulk(updates);
  if (creates.length) await store.createRecordsBulk(creates);
  await store.refreshRows();
  return { updated: updates.length, created: creates.length, skipped };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export async function exportTable(table: Table, rows: RecordRow[], format: "xlsx" | "csv"): Promise<void> {
  const path = await saveDialog({
    title: "Exportar tabela",
    defaultPath: `${table.name}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!path) return;

  const fields = table.fields.filter((f) => f.type !== "attachment");
  const header = fields.map((f) => f.name);
  const data = rows.map((r) => fields.map((f) => displayValue(f, r)));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, table.name.slice(0, 31) || "Dados");
  const b64 = XLSX.write(wb, { bookType: format, type: "base64" });
  await writeFileB64(path, b64);
}

function displayValue(f: Field, r: RecordRow): string | number | boolean {
  const v = r.cells[f.id];
  if (v == null) return "";
  switch (f.type) {
    case "select": {
      const c = (f.options.choices ?? []).find((x) => x.id === v);
      return c?.name ?? "";
    }
    case "multi_select": {
      const ids = Array.isArray(v) ? (v as string[]) : [];
      return ids
        .map((id) => (f.options.choices ?? []).find((x) => x.id === id)?.name)
        .filter(Boolean)
        .join(", ");
    }
    case "link":
      return Array.isArray(v) ? (v as number[]).map((id) => `#${id}`).join(", ") : "";
    case "checkbox":
      return v === true;
    case "number":
      return typeof v === "number" ? v : "";
    default:
      return String(v);
  }
}
