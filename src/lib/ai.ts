// IA local do LocalData.
//
// O maior diferencial da suíte: o modelo trabalha sobre DADOS ESTRUTURADOS.
// Padrão de segurança (decidido no projetos.md): a IA devolve um JSON de
// operações; o app VALIDA cada operação contra o schema e traduz para os
// comandos parametrizados do Rust. Nunca SQL cru do modelo.

import { invoke } from "@tauri-apps/api/core";
import * as api from "./backend";
import type { BaseSchema, CellValue, Field, FieldType, FilterSpec, RecordRow, Table } from "./types";
import { isComputed } from "./types";

// --- Rust command wrappers (camelCase keys -> snake_case Rust params) ---

export interface ModelInfo {
  name: string;
  path: string;
  size_gb: number;
  is_projector: boolean;
}

export interface LlmStatus {
  running: boolean;
  port: number;
  model: string;
}

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning?: string;
}

export const listModels = (dir: string) => invoke<ModelInfo[]>("list_models", { dir });
export const startLlm = (modelPath: string, nGpuLayers: number, ctxSize: number) =>
  invoke<number>("start_llm", { modelPath, nGpuLayers, ctxSize });
export const stopLlm = () => invoke<void>("stop_llm");
export const llmStatus = () => invoke<LlmStatus>("llm_status");

// --- llama-server HTTP (OpenAI-compatible, 127.0.0.1) ---

export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

export async function streamChat(
  port: number,
  messages: ChatMsg[],
  onDelta: (d: StreamDelta) => void,
  opts: { temperature?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      // Mesmo truque do LM Studio: desliga o "raciocínio" de modelos Qwen3 e
      // afins via template de chat. Modelos que não usam isso ignoram.
      chat_template_kwargs: { enable_thinking: false },
      reasoning_format: "none",
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`a IA respondeu ${res.status}`);

  let inThink = false;
  const routeContent = (text: string) => {
    while (text.length) {
      if (!inThink) {
        const i = text.indexOf("<think>");
        if (i === -1) return onDelta({ content: text });
        if (i > 0) onDelta({ content: text.slice(0, i) });
        inThink = true;
        text = text.slice(i + 7);
      } else {
        const j = text.indexOf("</think>");
        if (j === -1) return onDelta({ reasoning: text });
        if (j > 0) onDelta({ reasoning: text.slice(0, j) });
        inThink = false;
        text = text.slice(j + 8);
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) onDelta({ reasoning: delta.reasoning_content });
        if (delta.content) routeContent(delta.content);
      } catch {
        /* ignore partial */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// contexto: schema + amostra da tabela ativa
// ---------------------------------------------------------------------------

function fieldDesc(f: Field): string {
  let s = `"${f.name}" (${f.type}`;
  if ((f.type === "select" || f.type === "multi_select") && f.options.choices?.length) {
    s += `: ${f.options.choices.map((c) => c.name).join(" | ")}`;
  }
  if (f.type === "formula") s += `: ${f.options.expr ?? ""}`;
  s += ")";
  return s;
}

export function schemaContext(schema: BaseSchema): string {
  return schema.tables
    .map((t) => `Tabela "${t.name}": campos ${t.fields.map(fieldDesc).join(", ")}`)
    .join("\n");
}

export function rowsContext(table: Table, rows: RecordRow[], max = 20): string {
  const fields = table.fields.filter((f) => !isComputed(f.type) && f.type !== "attachment");
  const lines = rows.slice(0, max).map((r) => {
    const parts = fields.map((f) => {
      let v = r.cells[f.id];
      if (f.type === "select" && typeof v === "string") {
        v = (f.options.choices ?? []).find((c) => c.id === v)?.name ?? v;
      }
      if (f.type === "multi_select" && Array.isArray(v)) {
        v = (v as string[]).map((id) => (f.options.choices ?? []).find((c) => c.id === id)?.name ?? id).join("+");
      }
      return `${f.name}=${v == null || v === "" ? "∅" : JSON.stringify(v)}`;
    });
    return `[id ${r.id}] ${parts.join("; ")}`;
  });
  const extra = rows.length > max ? `\n(… e mais ${rows.length - max} registros não exibidos)` : "";
  return lines.join("\n") + extra;
}

export const DATA_SYSTEM = (schema: string, activeTable: string, rows: string) =>
  `Você é o assistente do LocalData, um banco de dados visual offline (estilo Airtable). ` +
  `Schema da base:\n${schema}\n\nTabela ativa: "${activeTable}". Registros visíveis:\n${rows}\n\n` +
  `Para MODIFICAR os dados, responda em duas partes: 1) uma frase curta do que vai fazer; ` +
  `2) um bloco \`\`\`json com um ARRAY de operações. Operações disponíveis:\n` +
  `- {"op":"createTable","name":"Clientes","fields":[{"name":"Nome","type":"text"},{"name":"Prioridade","type":"select","choices":["Alta","Baixa"]}]}\n` +
  `- {"op":"createField","table":"Clientes","name":"Email","type":"text"}\n` +
  `- {"op":"insert","table":"Clientes","rows":[{"Nome":"Ana","Prioridade":"Alta"}]}\n` +
  `- {"op":"update","table":"Clientes","id":3,"set":{"Prioridade":"Baixa"}}  (use o id mostrado em [id N])\n` +
  `- {"op":"setFilter","filters":[{"field":"Preço","op":"gt","value":100}]}  (ops: eq neq contains gt gte lt lte empty not_empty checked unchecked has)\n` +
  `Tipos de campo: text, long_text, number, checkbox, date, select, multi_select, formula, rating, url, email, phone.\n` +
  `Valores: número/rating como número JSON; checkbox true/false; data ISO "AAAA-MM-DD"; ` +
  `url/email/phone como texto; select/multi_select pelo NOME da opção (novas opções são criadas automaticamente); ` +
  `formula precisa de "expr" (ex.: {"name":"Total","type":"formula","expr":"{Preço} * {Qtd}"}).\n` +
  `Faça exatamente o que foi pedido, da forma mais direta. ` +
  `Para PERGUNTAS sobre os dados, responda só em texto, sem JSON.`;

// ---------------------------------------------------------------------------
// parse + validação + aplicação das operações
// ---------------------------------------------------------------------------

export interface AiOp {
  op: string;
  [k: string]: unknown;
}

export function parseOps(text: string): AiOp[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\[\s*\{[\s\S]*\}\s*\]/)?.[0];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw.trim());
    if (!Array.isArray(arr)) return [];
    return arr.filter((o) => o && typeof o.op === "string");
  } catch {
    return [];
  }
}

const AI_FIELD_TYPES: FieldType[] = [
  "text",
  "long_text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "formula",
  "rating",
  "url",
  "email",
  "phone",
];

let aiChoiceSeq = 0;
const newChoiceId = () => `ai${Date.now().toString(36)}${(aiChoiceSeq++).toString(36)}`;

function findTable(schema: BaseSchema, name: unknown, fallback: Table): Table {
  if (typeof name !== "string" || !name.trim()) return fallback;
  const t = schema.tables.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!t) throw new Error(`tabela desconhecida: "${name}"`);
  return t;
}

function findField(table: Table, name: string): Field {
  const f = table.fields.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!f) throw new Error(`campo desconhecido em "${table.name}": "${name}"`);
  return f;
}

/** Converte o valor "amigável" do modelo pro valor de célula, criando opções
 *  de select que ainda não existem. Retorna também opções novas a persistir. */
async function toCellValue(f: Field, v: unknown): Promise<CellValue> {
  if (v == null || v === "") return null;
  switch (f.type) {
    case "number":
    case "rating": {
      const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
      if (isNaN(n)) throw new Error(`número inválido pra "${f.name}": ${JSON.stringify(v)}`);
      return n;
    }
    case "checkbox":
      return v === true || v === 1 || String(v).toLowerCase() === "true";
    case "date": {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`data inválida pra "${f.name}" (use ISO): ${s}`);
      return s;
    }
    case "select": {
      const id = await ensureChoice(f, String(v));
      return id;
    }
    case "multi_select": {
      const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
      const ids: string[] = [];
      for (const item of arr) {
        const s = String(item).trim();
        if (s) ids.push(await ensureChoice(f, s));
      }
      return ids;
    }
    case "text":
    case "long_text":
    case "url":
    case "email":
    case "phone":
      return typeof v === "string" ? v : JSON.stringify(v);
    default:
      throw new Error(`a IA não pode escrever no campo "${f.name}" (${f.type})`);
  }
}

/** Garante que a opção exista no campo select (cria se preciso) e retorna o id. */
async function ensureChoice(f: Field, name: string): Promise<string> {
  const choices = f.options.choices ?? [];
  const hit = choices.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (hit) return hit.id;
  const created = { id: newChoiceId(), name: name.trim(), color: "" };
  const next = [...choices, created];
  await api.fieldUpdate(f.id, undefined, { ...f.options, choices: next });
  f.options = { ...f.options, choices: next }; // mantém o objeto local coerente
  return created.id;
}

export interface ApplyResult {
  applied: string[]; // descrições das operações aplicadas
  filters?: FilterSpec[]; // setFilter pendente (aplicado pela UI na view ativa)
  schemaChanged: boolean;
}

/**
 * Valida e aplica as operações da IA, uma a uma, na ordem.
 * Lança na primeira inválida (as anteriores já aplicadas ficam — cada uma é
 * uma transação própria no Rust).
 */
export async function applyOps(ops: AiOp[], schema: BaseSchema, active: Table): Promise<ApplyResult> {
  const applied: string[] = [];
  let filters: FilterSpec[] | undefined;
  let schemaChanged = false;
  // trabalha numa cópia viva do schema (createTable/createField mudam ele)
  let live = schema;

  const refreshLive = async () => {
    live = await api.baseSchema();
  };

  for (const op of ops) {
    switch (op.op) {
      case "createTable": {
        const name = String(op.name ?? "").trim();
        if (!name) throw new Error("createTable sem nome");
        const specs = Array.isArray(op.fields) ? op.fields : [];
        const tid = await api.tableCreate(name);
        // remove os campos default e cria os pedidos
        await refreshLive();
        const t = live.tables.find((x) => x.id === tid)!;
        const defaults = t.fields.map((f) => f.id);
        let created = 0;
        for (const spec of specs) {
          const fname = String((spec as Record<string, unknown>).name ?? "").trim();
          const ftype = String((spec as Record<string, unknown>).type ?? "text") as FieldType;
          if (!fname) continue;
          if (!AI_FIELD_TYPES.includes(ftype)) throw new Error(`tipo inválido em createTable: ${ftype}`);
          const options: Record<string, unknown> = {};
          const rawChoices = (spec as Record<string, unknown>).choices;
          if ((ftype === "select" || ftype === "multi_select") && Array.isArray(rawChoices)) {
            options.choices = rawChoices.map((c) => ({ id: newChoiceId(), name: String(c), color: "" }));
          }
          if (ftype === "formula") options.expr = String((spec as Record<string, unknown>).expr ?? "");
          await api.fieldCreate(tid, fname, ftype, options);
          created++;
        }
        if (created > 0) for (const fid of defaults) await api.fieldDelete(fid);
        await refreshLive();
        applied.push(`tabela "${name}" criada com ${Math.max(created, 2)} campos`);
        schemaChanged = true;
        break;
      }
      case "createField": {
        const t = findTable(live, op.table, active);
        const fname = String(op.name ?? "").trim();
        const ftype = String(op.type ?? "text") as FieldType;
        if (!fname) throw new Error("createField sem nome");
        if (!AI_FIELD_TYPES.includes(ftype)) throw new Error(`tipo inválido: ${ftype}`);
        const options: Record<string, unknown> = {};
        if ((ftype === "select" || ftype === "multi_select") && Array.isArray(op.choices)) {
          options.choices = (op.choices as unknown[]).map((c) => ({ id: newChoiceId(), name: String(c), color: "" }));
        }
        if (ftype === "formula") options.expr = String(op.expr ?? "");
        await api.fieldCreate(t.id, fname, ftype, options);
        await refreshLive();
        applied.push(`campo "${fname}" (${ftype}) criado em "${t.name}"`);
        schemaChanged = true;
        break;
      }
      case "insert": {
        const t = findTable(live, op.table, active);
        const rows = Array.isArray(op.rows) ? op.rows : [];
        const converted: Record<string, CellValue>[] = [];
        for (const row of rows) {
          if (typeof row !== "object" || row == null) continue;
          const cells: Record<string, CellValue> = {};
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            const f = findField(t, k);
            cells[f.id] = await toCellValue(f, v);
          }
          converted.push(cells);
        }
        if (converted.length) await api.recordsInsertBulk(t.id, converted);
        applied.push(`${converted.length} registro(s) inserido(s) em "${t.name}"`);
        break;
      }
      case "update": {
        const t = findTable(live, op.table, active);
        const id = typeof op.id === "number" ? op.id : parseInt(String(op.id), 10);
        if (isNaN(id)) throw new Error("update sem id numérico");
        const setSpec = op.set;
        if (typeof setSpec !== "object" || setSpec == null) throw new Error("update sem 'set'");
        const cells: Record<string, CellValue> = {};
        for (const [k, v] of Object.entries(setSpec as Record<string, unknown>)) {
          const f = findField(t, k);
          cells[f.id] = await toCellValue(f, v);
        }
        await api.recordsUpdate(t.id, [{ id, cells }]);
        applied.push(`registro ${id} atualizado em "${t.name}"`);
        break;
      }
      case "setFilter": {
        const specs = Array.isArray(op.filters) ? op.filters : [];
        const out: FilterSpec[] = [];
        for (const spec of specs) {
          const s = spec as Record<string, unknown>;
          const f = findField(active, String(s.field ?? ""));
          const fop = String(s.op ?? "eq") as FilterSpec["op"];
          let value: unknown = s.value;
          if (f.type === "select" || f.type === "multi_select") {
            const c = (f.options.choices ?? []).find(
              (x) => x.name.trim().toLowerCase() === String(value ?? "").trim().toLowerCase()
            );
            value = c?.id ?? value;
          }
          out.push({ fieldId: f.id, op: fop, value });
        }
        filters = out;
        applied.push(`filtro definido (${out.length} condição/ões)`);
        break;
      }
      default:
        throw new Error(`operação desconhecida: "${op.op}"`);
    }
  }
  return { applied, filters, schemaChanged };
}
