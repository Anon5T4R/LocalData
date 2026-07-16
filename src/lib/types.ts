// Modelo de dados do LocalData — espelha o que o Rust serializa (camelCase).

import { t as tr, type MessageKey } from "./i18n";

export type FieldType =
  | "text"
  | "long_text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi_select"
  | "link"
  | "attachment"
  | "formula"
  | "rating"
  | "url"
  | "email"
  | "phone"
  | "lookup"
  | "rollup"
  | "custom";

/** Campos computados no frontend: sem coluna no banco, somente leitura. */
export function isComputed(t: FieldType): boolean {
  return t === "formula" || t === "lookup" || t === "rollup";
}

export type NumberFormat = "decimal" | "integer" | "currency" | "percent";
export type RollupAgg = "count" | "sum" | "avg" | "min" | "max" | "join";

export interface Choice {
  id: string;
  name: string;
  color: string; // css color ou "" (auto)
}

export interface FieldOptions {
  choices?: Choice[]; // select / multi_select
  tableId?: string; // link: tabela alvo
  expr?: string; // formula
  precision?: number; // number
  format?: NumberFormat; // number: exibição
  includeTime?: boolean; // date
  ratingMax?: number; // rating: nº de estrelas (default 5)
  linkFieldId?: string; // lookup/rollup: campo de relação desta tabela
  targetFieldId?: string; // lookup/rollup: campo da tabela relacionada
  agg?: RollupAgg; // rollup
  extType?: string; // custom: id do tipo registrado por uma extensão
  description?: string; // qualquer tipo: tooltip no cabeçalho
  // --- constraints (validadas no Rust, dentro da transação) ---
  unique?: boolean; // valor não pode repetir na tabela
  required?: boolean; // obrigatório no formulário (nível de UI)
  regex?: string; // tipos texto: precisa casar
  min?: number | string; // constraint: número (num) ou data (ISO)
  max?: number | string; // constraint: número (num) ou data (ISO)
  onDelete?: "restrict" | "unlink"; // link: impedir exclusão do alvo, ou desvincular (padrão)
}

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  options: FieldOptions;
  pos: number;
}

export type ViewKind = "grid" | "kanban" | "calendar" | "gallery" | "form";

export interface FilterSpec {
  fieldId: string;
  op:
    | "eq"
    | "neq"
    | "contains"
    | "not_contains"
    | "empty"
    | "not_empty"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "checked"
    | "unchecked"
    | "has"
    | "has_record";
  value?: unknown;
}

export interface SortSpec {
  fieldId: string;
  desc: boolean;
}

/** Agregação de rodapé da grade, por coluna. */
export type AggKind = "filled" | "sum" | "avg" | "min" | "max";

export interface ViewConfig {
  filters?: FilterSpec[];
  sorts?: SortSpec[];
  hiddenFields?: string[];
  widths?: Record<string, number>; // grid: largura por campo
  rowHeight?: "short" | "medium" | "tall"; // grid
  groupField?: string; // kanban: campo select; grid: agrupamento
  colorField?: string; // grid: campo select que colore as linhas
  aggs?: Record<string, AggKind>; // grid: agregação do rodapé por campo
  dateField?: string; // calendar: campo date
  coverField?: string; // gallery: campo attachment
  formFields?: string[]; // form: campos exibidos, em ordem
  formTitle?: string;
  formDescription?: string;
}

export interface View {
  id: string;
  name: string;
  kind: ViewKind;
  config: ViewConfig;
  pos: number;
}

export interface Table {
  id: string;
  name: string;
  pos: number;
  fields: Field[];
  views: View[];
}

export interface BaseSchema {
  path: string;
  name: string;
  tables: Table[];
}

/** Valor de célula como vem/vai pro Rust. */
export type CellValue = string | number | boolean | string[] | number[] | null;

export interface RecordRow {
  id: number;
  cells: Record<string, CellValue>;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Ordem canônica dos tipos de campo (pro seletor). */
export const FIELD_TYPES: FieldType[] = [
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

/** Rótulo localizado do tipo de campo. */
export function fieldTypeLabel(t: FieldType): string {
  return tr(`ftype.${t}` as MessageKey);
}

export const FIELD_TYPE_ICON: Record<FieldType, string> = {
  text: "A",
  long_text: "¶",
  number: "#",
  checkbox: "☑",
  date: "📅",
  select: "◉",
  multi_select: "☰",
  link: "↗",
  attachment: "📎",
  formula: "ƒx",
  rating: "★",
  url: "🔗",
  email: "@",
  phone: "☎",
  lookup: "👁",
  rollup: "Σ",
  custom: "🧩",
};

/** Ordem canônica das agregações de rollup (pro seletor). */
export const ROLLUP_AGGS: RollupAgg[] = ["count", "sum", "avg", "min", "max", "join"];

/** Rótulo localizado da agregação de rollup. */
export function rollupAggLabel(a: RollupAgg): string {
  return tr(`agg.${a}` as MessageKey);
}

export const CHOICE_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#ef4444",
  "#eab308",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#64748b",
  "#84cc16",
];

export function choiceColor(c: Choice, idx: number): string {
  return c.color || CHOICE_COLORS[idx % CHOICE_COLORS.length];
}

/** Campo "primário" da tabela: o primeiro por posição. */
export function primaryField(table: Table): Field | undefined {
  return table.fields[0];
}

/** Operadores de filtro aplicáveis por tipo. */
export function opsForType(t: FieldType): { op: FilterSpec["op"]; label: string; needsValue: boolean }[] {
  switch (t) {
    case "number":
    case "rating":
      return [
        { op: "eq", label: "=", needsValue: true },
        { op: "neq", label: "≠", needsValue: true },
        { op: "gt", label: ">", needsValue: true },
        { op: "gte", label: "≥", needsValue: true },
        { op: "lt", label: "<", needsValue: true },
        { op: "lte", label: "≤", needsValue: true },
        { op: "empty", label: tr("op.empty"), needsValue: false },
        { op: "not_empty", label: tr("op.notEmpty"), needsValue: false },
      ];
    case "checkbox":
      return [
        { op: "checked", label: tr("op.checked"), needsValue: false },
        { op: "unchecked", label: tr("op.unchecked"), needsValue: false },
      ];
    case "date":
      return [
        { op: "eq", label: tr("op.is"), needsValue: true },
        { op: "gt", label: tr("op.after"), needsValue: true },
        { op: "lt", label: tr("op.before"), needsValue: true },
        { op: "empty", label: tr("op.empty"), needsValue: false },
        { op: "not_empty", label: tr("op.notEmpty"), needsValue: false },
      ];
    case "select":
      return [
        { op: "eq", label: tr("op.is"), needsValue: true },
        { op: "neq", label: tr("op.isNot"), needsValue: true },
        { op: "empty", label: tr("op.empty"), needsValue: false },
        { op: "not_empty", label: tr("op.notEmpty"), needsValue: false },
      ];
    case "multi_select":
      return [
        { op: "has", label: tr("op.contains"), needsValue: true },
        { op: "empty", label: tr("op.empty"), needsValue: false },
        { op: "not_empty", label: tr("op.notEmpty"), needsValue: false },
      ];
    case "link":
    case "attachment":
      return [
        { op: "empty", label: tr("op.empty"), needsValue: false },
        { op: "not_empty", label: tr("op.notEmpty"), needsValue: false },
      ];
    case "formula":
    case "lookup":
    case "rollup":
      return [];
    default:
      return [
        { op: "contains", label: tr("op.contains"), needsValue: true },
        { op: "not_contains", label: tr("op.notContains"), needsValue: true },
        { op: "eq", label: tr("op.is"), needsValue: true },
        { op: "neq", label: tr("op.isNot"), needsValue: true },
        { op: "empty", label: tr("op.empty"), needsValue: false },
        { op: "not_empty", label: tr("op.notEmpty"), needsValue: false },
      ];
  }
}
