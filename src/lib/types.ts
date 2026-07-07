// Modelo de dados do LocalData — espelha o que o Rust serializa (camelCase).

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
  | "rollup";

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
  max?: number; // rating: estrelas (default 5)
  linkFieldId?: string; // lookup/rollup: campo de relação desta tabela
  targetFieldId?: string; // lookup/rollup: campo da tabela relacionada
  agg?: RollupAgg; // rollup
  description?: string; // qualquer tipo: tooltip no cabeçalho
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

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Texto",
  long_text: "Texto longo",
  number: "Número",
  checkbox: "Checkbox",
  date: "Data",
  select: "Seleção única",
  multi_select: "Seleção múltipla",
  link: "Relação",
  attachment: "Anexo",
  formula: "Fórmula",
  rating: "Avaliação",
  url: "URL",
  email: "E-mail",
  phone: "Telefone",
  lookup: "Lookup (via relação)",
  rollup: "Rollup (agregação)",
};

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
};

export const ROLLUP_AGG_LABEL: Record<RollupAgg, string> = {
  count: "Contar",
  sum: "Somar",
  avg: "Média",
  min: "Mínimo",
  max: "Máximo",
  join: "Listar valores",
};

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
        { op: "empty", label: "está vazio", needsValue: false },
        { op: "not_empty", label: "não está vazio", needsValue: false },
      ];
    case "checkbox":
      return [
        { op: "checked", label: "marcado", needsValue: false },
        { op: "unchecked", label: "desmarcado", needsValue: false },
      ];
    case "date":
      return [
        { op: "eq", label: "é", needsValue: true },
        { op: "gt", label: "depois de", needsValue: true },
        { op: "lt", label: "antes de", needsValue: true },
        { op: "empty", label: "está vazio", needsValue: false },
        { op: "not_empty", label: "não está vazio", needsValue: false },
      ];
    case "select":
      return [
        { op: "eq", label: "é", needsValue: true },
        { op: "neq", label: "não é", needsValue: true },
        { op: "empty", label: "está vazio", needsValue: false },
        { op: "not_empty", label: "não está vazio", needsValue: false },
      ];
    case "multi_select":
      return [
        { op: "has", label: "contém", needsValue: true },
        { op: "empty", label: "está vazio", needsValue: false },
        { op: "not_empty", label: "não está vazio", needsValue: false },
      ];
    case "link":
    case "attachment":
      return [
        { op: "empty", label: "está vazio", needsValue: false },
        { op: "not_empty", label: "não está vazio", needsValue: false },
      ];
    case "formula":
    case "lookup":
    case "rollup":
      return [];
    default:
      return [
        { op: "contains", label: "contém", needsValue: true },
        { op: "not_contains", label: "não contém", needsValue: true },
        { op: "eq", label: "é", needsValue: true },
        { op: "neq", label: "não é", needsValue: true },
        { op: "empty", label: "está vazio", needsValue: false },
        { op: "not_empty", label: "não está vazio", needsValue: false },
      ];
  }
}
