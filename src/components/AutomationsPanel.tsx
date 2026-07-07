// Automações da tabela ativa: "quando X → faça Y". Editor simples de regras.

import { useEffect, useState } from "react";
import * as api from "../lib/backend";
import { parseAutomation, type Automation } from "../lib/automations";
import { activeTable, useStore } from "../state/store";
import { isComputed } from "../lib/types";

const blank = (tableId: string): Automation => ({
  id: "",
  tableId,
  name: "Nova automação",
  enabled: true,
  trigger: { kind: "record_created" },
  action: { kind: "notify", message: "" },
});

export function AutomationsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const table = activeTable(store);
  const [list, setList] = useState<Automation[]>([]);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [err, setErr] = useState("");

  const load = async () => {
    if (!table) return;
    try {
      const all = await api.automationsList(table.id);
      setList(all.map(parseAutomation));
    } catch (e) {
      setErr(String(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.id]);

  if (!table) return null;

  const triggerFields = table.fields.filter((f) => f.type === "select" || f.type === "checkbox");
  const settableFields = table.fields.filter((f) => !isComputed(f.type) && f.type !== "attachment" && f.type !== "link" && f.type !== "multi_select");

  const save = async () => {
    if (!editing) return;
    try {
      const { id, tableId, ...config } = editing;
      await api.automationSave(id || null, tableId, config);
      setEditing(null);
      await load();
      await store.reloadAutomations();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.automationDelete(id);
      await load();
      await store.reloadAutomations();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const describe = (a: Automation): string => {
    const when =
      a.trigger.kind === "record_created"
        ? "ao criar registro"
        : `quando "${table.fields.find((f) => f.id === (a.trigger as { fieldId: string }).fieldId)?.name ?? "?"}" = ${(a.trigger as { value: string }).value}`;
    const then =
      a.action.kind === "notify"
        ? "notificar"
        : `definir "${table.fields.find((f) => f.id === (a.action as { fieldId: string }).fieldId)?.name ?? "?"}"`;
    return `${when} → ${then}`;
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal automations-panel">
        <div className="record-modal-head">
          <h3>⚡ Automações — {table.name}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        {err && <div className="ai-err">{err}</div>}

        {!editing && (
          <>
            {list.length === 0 && <p className="muted">Nenhuma automação. Crie uma regra "quando algo acontecer, faça X".</p>}
            {list.map((a) => (
              <div key={a.id} className="automation-row">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={async (e) => {
                      const { id, tableId, ...config } = { ...a, enabled: e.target.checked };
                      await api.automationSave(id, tableId, config);
                      await load();
                      await store.reloadAutomations();
                    }}
                  />
                  <span className="automation-name">{a.name}</span>
                </label>
                <span className="automation-desc muted">{describe(a)}</span>
                <button className="icon-btn" title="Editar" onClick={() => setEditing(a)}>
                  ✏️
                </button>
                <button className="icon-btn" title="Excluir" onClick={() => void remove(a.id)}>
                  🗑
                </button>
              </div>
            ))}
            <button className="btn btn-sm" onClick={() => setEditing(blank(table.id))}>
              + Nova automação
            </button>
          </>
        )}

        {editing && (
          <div className="automation-editor">
            <label className="form-label">Nome</label>
            <input
              className="input input-sm"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />

            <label className="form-label">Quando</label>
            <select
              className="input input-sm"
              value={editing.trigger.kind}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  trigger:
                    e.target.value === "record_created"
                      ? { kind: "record_created" }
                      : { kind: "field_becomes", fieldId: triggerFields[0]?.id ?? "", value: "" },
                })
              }
            >
              <option value="record_created">um registro for criado</option>
              <option value="field_becomes" disabled={!triggerFields.length}>
                um campo passar a ter um valor
              </option>
            </select>
            {editing.trigger.kind === "field_becomes" && (
              <div className="pop-row">
                <select
                  className="input input-sm"
                  value={editing.trigger.fieldId}
                  onChange={(e) =>
                    setEditing({ ...editing, trigger: { kind: "field_becomes", fieldId: e.target.value, value: (editing.trigger as { value: string }).value } })
                  }
                >
                  {triggerFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <FieldValueInput
                  table={table}
                  fieldId={editing.trigger.fieldId}
                  value={editing.trigger.value}
                  onChange={(v) =>
                    setEditing({ ...editing, trigger: { kind: "field_becomes", fieldId: (editing.trigger as { fieldId: string }).fieldId, value: v } })
                  }
                />
              </div>
            )}

            <label className="form-label">Então</label>
            <select
              className="input input-sm"
              value={editing.action.kind}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  action:
                    e.target.value === "notify"
                      ? { kind: "notify", message: "" }
                      : { kind: "set_field", fieldId: settableFields[0]?.id ?? "", value: "" },
                })
              }
            >
              <option value="notify">mostrar uma notificação</option>
              <option value="set_field" disabled={!settableFields.length}>
                definir outro campo do registro
              </option>
            </select>
            {editing.action.kind === "notify" ? (
              <>
                <input
                  className="input input-sm"
                  placeholder="Mensagem (use {Campo} pra inserir valores)"
                  value={editing.action.message}
                  onChange={(e) => setEditing({ ...editing, action: { kind: "notify", message: e.target.value } })}
                />
                <p className="hint">Ex.: "Pedido de {"{Cliente}"} ficou {"{Status}"}".</p>
              </>
            ) : (
              <div className="pop-row">
                <select
                  className="input input-sm"
                  value={editing.action.fieldId}
                  onChange={(e) =>
                    setEditing({ ...editing, action: { kind: "set_field", fieldId: e.target.value, value: (editing.action as { value: string }).value } })
                  }
                >
                  {settableFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <FieldValueInput
                  table={table}
                  fieldId={editing.action.fieldId}
                  value={editing.action.value}
                  onChange={(v) =>
                    setEditing({ ...editing, action: { kind: "set_field", fieldId: (editing.action as { fieldId: string }).fieldId, value: v } })
                  }
                />
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setEditing(null)}>
                Cancelar
              </button>
              <button className="btn btn-sm primary" onClick={() => void save()}>
                Salvar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldValueInput({
  table,
  fieldId,
  value,
  onChange,
}: {
  table: { fields: { id: string; type: string; options: { choices?: { id: string; name: string }[] } }[] };
  fieldId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const f = table.fields.find((x) => x.id === fieldId);
  if (f?.type === "select") {
    return (
      <select className="input input-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(f.options.choices ?? []).map((c) => (
          <option key={c.id} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    );
  }
  if (f?.type === "checkbox") {
    return (
      <select className="input input-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">marcado</option>
        <option value="false">desmarcado</option>
      </select>
    );
  }
  return <input className="input input-sm" placeholder="valor" value={value} onChange={(e) => onChange(e.target.value)} />;
}
