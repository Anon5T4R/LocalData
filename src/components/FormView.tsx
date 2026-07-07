// Formulário de entrada: preenche os campos e cria um registro por envio.

import { useState } from "react";
import { activeTable, activeView, useStore } from "../state/store";
import type { CellValue } from "../lib/types";
import { FIELD_TYPE_LABEL, isComputed } from "../lib/types";
import { CellDisplay, CellEditor } from "./cells";

export function FormView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const [draft, setDraft] = useState<Record<string, CellValue>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (!table || !view) return null;

  const order = view.config.formFields;
  const fields = (
    order ? (order.map((id) => table.fields.find((f) => f.id === id)).filter(Boolean) as typeof table.fields) : table.fields
  ).filter((f) => !isComputed(f.type));

  const submit = async () => {
    const id = await store.addRecord(draft);
    if (id != null) {
      setDraft({});
      setEditing(null);
      setSent(true);
      setTimeout(() => setSent(false), 2500);
    }
  };

  return (
    <div className="form-view">
      <div className="form-card">
        <h2>{view.config.formTitle || table.name}</h2>
        {view.config.formDescription && <p className="muted">{view.config.formDescription}</p>}
        {fields.map((f) => (
          <div key={f.id} className="record-field">
            <div className="record-field-label">{f.name}</div>
            <div
              className="record-field-value"
              onClick={() => f.type !== "checkbox" && f.type !== "rating" && editing !== f.id && setEditing(f.id)}
            >
              {editing === f.id ? (
                <CellEditor
                  field={f}
                  value={draft[f.id] ?? null}
                  tables={store.schema?.tables ?? []}
                  commit={(v) => {
                    setDraft({ ...draft, [f.id]: v });
                    setEditing(null);
                  }}
                  cancel={() => setEditing(null)}
                />
              ) : (
                <CellDisplay
                  field={f}
                  value={draft[f.id] ?? null}
                  row={{ id: -1, cells: draft }}
                  table={table}
                  tables={store.schema?.tables ?? []}
                  onToggle={f.type === "checkbox" ? (v) => setDraft({ ...draft, [f.id]: v }) : undefined}
                  onRate={f.type === "rating" ? (n) => setDraft({ ...draft, [f.id]: n || null }) : undefined}
                />
              )}
              {draft[f.id] == null && editing !== f.id && f.type !== "checkbox" && f.type !== "rating" && (
                <span className="muted form-placeholder">{FIELD_TYPE_LABEL[f.type]}…</span>
              )}
            </div>
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn primary" onClick={() => void submit()}>
            Enviar
          </button>
          {sent && <span className="sent-ok">✓ Registro criado</span>}
        </div>
      </div>
    </div>
  );
}
