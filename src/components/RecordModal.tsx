// Modal de registro: todos os campos em formulário vertical.
// Usado pela grade (expand), kanban, calendário e galeria; e para criar
// registro novo ("new").

import { useEffect, useState } from "react";
import { activeTable, useStore } from "../state/store";
import type { CellValue, Field, RecordRow } from "../lib/types";
import { FIELD_TYPE_ICON, FIELD_TYPE_LABEL } from "../lib/types";
import { CellDisplay, CellEditor, invalidateLinkLabels } from "./cells";

export function RecordModal() {
  const store = useStore();
  const table = activeTable(store);
  const openId = store.openRecordId;
  const [draft, setDraft] = useState<Record<string, CellValue>>({});
  const [editingField, setEditingField] = useState<string | null>(null);

  const isNew = openId === "new";
  const row = !isNew && openId != null ? store.rows.find((r) => r.id === openId) : undefined;

  useEffect(() => {
    setDraft({});
    setEditingField(null);
  }, [openId]);

  if (!table || openId == null) return null;
  if (!isNew && !row) return null;

  const effRow: RecordRow = isNew
    ? { id: -1, cells: draft }
    : { id: row!.id, cells: { ...row!.cells, ...draft } };

  const commitField = (f: Field, v: CellValue) => {
    setEditingField(null);
    if (isNew) {
      setDraft({ ...draft, [f.id]: v });
    } else {
      invalidateLinkLabels(table.id);
      void store.updateRecord(row!.id, { [f.id]: v });
    }
  };

  const createNow = async () => {
    const id = await store.addRecord(draft);
    if (id != null) store.setOpenRecord(null);
  };

  const close = () => store.setOpenRecord(null);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal record-modal">
        <div className="record-modal-head">
          <h3>{isNew ? "Novo registro" : `Registro #${row!.id}`}</h3>
          <button className="icon-btn" onClick={close}>
            ×
          </button>
        </div>
        <div className="record-fields">
          {table.fields.map((f) => (
            <div key={f.id} className="record-field">
              <div className="record-field-label" title={FIELD_TYPE_LABEL[f.type]}>
                <span className="ftype">{FIELD_TYPE_ICON[f.type]}</span> {f.name}
              </div>
              <div
                className="record-field-value"
                onClick={() => {
                  if (f.type !== "formula" && f.type !== "checkbox" && editingField !== f.id) {
                    setEditingField(f.id);
                  }
                }}
              >
                {editingField === f.id ? (
                  <CellEditor
                    field={f}
                    value={effRow.cells[f.id] ?? null}
                    tables={store.schema?.tables ?? []}
                    commit={(v) => commitField(f, v)}
                    cancel={() => setEditingField(null)}
                  />
                ) : (
                  <CellDisplay
                    field={f}
                    value={effRow.cells[f.id] ?? null}
                    row={effRow}
                    table={table}
                    tables={store.schema?.tables ?? []}
                    onToggle={f.type === "checkbox" ? (v) => commitField(f, v) : undefined}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          {!isNew && (
            <button
              className="btn danger"
              onClick={() => {
                if (confirm("Excluir este registro?")) {
                  void store.deleteRecords([row!.id]);
                  close();
                }
              }}
            >
              Excluir
            </button>
          )}
          <span style={{ flex: 1 }} />
          {isNew ? (
            <>
              <button className="btn" onClick={close}>
                Cancelar
              </button>
              <button className="btn primary" onClick={() => void createNow()}>
                Criar registro
              </button>
            </>
          ) : (
            <button className="btn" onClick={close}>
              Fechar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
