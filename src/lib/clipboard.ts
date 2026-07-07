// Copiar/colar de células em TSV (compatível com Excel/Sheets/Airtable).
// Copiar usa o texto "plano" por tipo (cells.tsx); colar converte texto de
// volta pro valor tipado — opções de select inexistentes são criadas antes.

import type { CellValue, Choice, Field } from "./types";
import { isComputed } from "./types";

/** Serializa uma matriz de textos em TSV (célula com tab/quebra vira aspas). */
export function toTsv(matrix: string[][]): string {
  return matrix
    .map((row) =>
      row
        .map((cell) => (/[\t\n\r"]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell))
        .join("\t")
    )
    .join("\n");
}

/** Parse de TSV (com suporte a células entre aspas, como o Excel gera). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && cur === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  row.push(cur);
  rows.push(row);
  return rows;
}

/** Número a partir de texto pt-BR ou en (aceita R$, %, milhar). */
export function parseNumberText(s: string): number | null {
  let t = s.trim().replace(/[R$\s%]/g, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(",", ".");
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

/** Data ISO a partir de "dd/mm/aaaa[ hh:mm]" ou ISO direto. */
export function parseDateText(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.replace(" ", "T");
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const base = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return m[4] ? `${base}T${m[4].padStart(2, "0")}:${m[5]}` : base;
}

let choiceSeq = 0;
export function newChoiceId(): string {
  return `ch${Date.now().toString(36)}${(choiceSeq++).toString(36)}`;
}

/**
 * Nomes de opção citados nos textos que ainda não existem no campo
 * (select: texto inteiro; multi_select: separado por vírgula).
 */
export function missingChoiceNames(field: Field, texts: string[]): string[] {
  const existing = new Set((field.options.choices ?? []).map((c) => c.name.toLowerCase()));
  const out: string[] = [];
  for (const t of texts) {
    const names = field.type === "multi_select" ? t.split(",").map((x) => x.trim()) : [t.trim()];
    for (const n of names) {
      if (n && !existing.has(n.toLowerCase()) && !out.some((o) => o.toLowerCase() === n.toLowerCase())) {
        out.push(n);
      }
    }
  }
  return out;
}

/**
 * Converte texto colado pro valor tipado do campo.
 * Retorna `undefined` quando o campo não aceita colagem (computado, relação,
 * anexo) — a célula é pulada, mas a coluna conta na posição.
 * `choices` deve já incluir as opções recém-criadas.
 */
export function textToCell(field: Field, text: string, choices?: Choice[]): CellValue | undefined {
  if (isComputed(field.type) || field.type === "link" || field.type === "attachment") return undefined;
  const t = text.trim();
  switch (field.type) {
    case "number":
      return t === "" ? null : parseNumberText(t);
    case "rating": {
      if (t === "") return null;
      const n = parseNumberText(t.replace(/★/g, "").trim() || String(t.match(/★/g)?.length ?? ""));
      return n == null ? (t.match(/★/g)?.length ?? null) : n;
    }
    case "checkbox":
      return ["1", "true", "sim", "yes", "x", "✓", "✔"].includes(t.toLowerCase());
    case "date":
      return t === "" ? null : parseDateText(t);
    case "select": {
      if (t === "") return null;
      const c = (choices ?? field.options.choices ?? []).find((c) => c.name.toLowerCase() === t.toLowerCase());
      return c ? c.id : null;
    }
    case "multi_select": {
      if (t === "") return [];
      const all = choices ?? field.options.choices ?? [];
      return t
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((n) => all.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id)
        .filter((id): id is string => !!id);
    }
    default:
      // text, long_text, url, email, phone
      return t === "" ? null : text;
  }
}
