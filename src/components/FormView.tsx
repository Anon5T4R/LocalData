// Formulário de entrada: preenche os campos e cria um registro por envio.

import { useState } from "react";
import { activeTable, activeView, useStore } from "../state/store";
import type { CellValue } from "../lib/types";
import { fieldTypeLabel, isComputed } from "../lib/types";
import { CellDisplay, CellEditor } from "./cells";
import { t } from "../lib/i18n";

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

  const missingRequired = fields.filter((f) => {
    if (!f.options.required) return false;
    const v = draft[f.id];
    return v == null || v === "" || (Array.isArray(v) && v.length === 0);
  });

  const submit = async () => {
    if (missingRequired.length) {
      store.setError(t("form.missingRequired", { fields: missingRequired.map((f) => f.name).join(", ") }));
      return;
    }
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
            <div className="record-field-label">
              {f.name}
              {f.options.required && <span className="req-mark" title={t("form.requiredMark")}> *</span>}
            </div>
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
                <span className="muted form-placeholder">{t("form.placeholderSuffix", { label: fieldTypeLabel(f.type) })}</span>
              )}
            </div>
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn primary" onClick={() => void submit()}>
            {t("form.submit")}
          </button>
          {sent && <span className="sent-ok">{t("form.created")}</span>}
        </div>
      </div>
    </div>
  );
}
