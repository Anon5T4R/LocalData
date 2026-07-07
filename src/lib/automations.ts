// Automações: regras "quando X acontecer, faça Y" por tabela.
//
// Escopo (deliberadamente simples e sem cascata): o gatilho é avaliado no
// FRONTEND de quem fez a edição, logo após a mutação. Um nível só — a ação de
// definir campo NÃO dispara outras automações (evita laços). Config é JSON
// guardado em _taylor_automations (opaco pro Rust).
//
// Gatilhos:
//  - record_created: sempre que um registro é criado na tabela
//  - field_becomes: quando um campo passa a ter certo valor (select/checkbox/…)
// Ações:
//  - notify: notificação do sistema (mensagem com {Campo} interpolado)
//  - set_field: define outro campo do MESMO registro

import * as api from "./backend";
import type { CellValue, Field, RecordRow, Table } from "./types";

export interface Automation {
  id: string;
  tableId: string;
  name: string;
  enabled: boolean;
  trigger:
    | { kind: "record_created" }
    | { kind: "field_becomes"; fieldId: string; value: string };
  action:
    | { kind: "notify"; message: string }
    | { kind: "set_field"; fieldId: string; value: string };
}

export function parseAutomation(a: api.AutomationMeta): Automation {
  const c = a.config as Partial<Automation>;
  return {
    id: a.id,
    tableId: a.tableId,
    name: c.name ?? "Automação",
    enabled: c.enabled ?? true,
    trigger: c.trigger ?? { kind: "record_created" },
    action: c.action ?? { kind: "notify", message: "" },
  };
}

/** Interpola {Nome do Campo} na mensagem com o texto exibido da célula. */
function interpolate(msg: string, table: Table, cells: Record<string, CellValue>): string {
  return msg.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const f = table.fields.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!f) return `{${name}}`;
    const v = cells[f.id];
    if (v == null) return "";
    if (f.type === "select") return (f.options.choices ?? []).find((c) => c.id === v)?.name ?? "";
    return String(v);
  });
}

async function notify(title: string, body: string) {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) granted = (await mod.requestPermission()) === "granted";
    if (granted) mod.sendNotification({ title, body });
  } catch {
    /* plugin ausente/negado: silencioso */
  }
}

/** Converte o valor "amigável" da ação set_field pro valor de célula do campo. */
function actionValue(f: Field, raw: string): CellValue {
  switch (f.type) {
    case "checkbox":
      return ["1", "true", "sim", "yes", "x"].includes(raw.trim().toLowerCase());
    case "number":
    case "rating": {
      const n = parseFloat(raw.replace(",", "."));
      return isNaN(n) ? null : n;
    }
    case "select":
      return (f.options.choices ?? []).find((c) => c.name.trim().toLowerCase() === raw.trim().toLowerCase())?.id ?? null;
    default:
      return raw || null;
  }
}

/**
 * Roda as automações de uma tabela para os registros afetados.
 * `event` diz o que aconteceu; `rows` são os registros já com o estado NOVO.
 * Devolve updates a aplicar (set_field) — o chamador grava em lote.
 */
export async function runAutomations(
  automations: Automation[],
  table: Table,
  event: "created" | "updated",
  rows: RecordRow[]
): Promise<{ id: number; cells: Record<string, CellValue> }[]> {
  const active = automations.filter((a) => a.enabled && a.tableId === table.id);
  if (!active.length) return [];
  const updates: { id: number; cells: Record<string, CellValue> }[] = [];

  for (const auto of active) {
    const trig = auto.trigger;
    const act = auto.action;
    for (const row of rows) {
      // gatilho
      let fires = false;
      if (trig.kind === "record_created") {
        fires = event === "created";
      } else {
        const f = table.fields.find((x) => x.id === trig.fieldId);
        if (f) {
          const v = row.cells[f.id];
          const cur = f.type === "select" ? String(v ?? "") : f.type === "checkbox" ? (v ? "true" : "false") : String(v ?? "");
          const want =
            f.type === "select"
              ? (f.options.choices ?? []).find((c) => c.name.trim().toLowerCase() === trig.value.trim().toLowerCase())?.id ?? trig.value
              : trig.value;
          fires = cur === want || (f.type !== "select" && cur.trim().toLowerCase() === trig.value.trim().toLowerCase());
        }
      }
      if (!fires) continue;

      // ação
      if (act.kind === "notify") {
        void notify(`Automação: ${auto.name}`, interpolate(act.message, table, row.cells));
      } else {
        const f = table.fields.find((x) => x.id === act.fieldId);
        if (f) updates.push({ id: row.id, cells: { [f.id]: actionValue(f, act.value) } });
      }
    }
  }
  return updates;
}
