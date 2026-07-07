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
