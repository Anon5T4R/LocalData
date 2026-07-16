// Modal de registro: todos os campos em formulário vertical.
// Usado pela grade (expand), kanban, calendário e galeria; e para criar
// registro novo ("new").

import { useEffect, useState } from "react";
import { activeTable, useStore } from "../state/store";
import type { CellValue, Field, RecordRow } from "../lib/types";
import { FIELD_TYPE_ICON, fieldTypeLabel, isComputed } from "../lib/types";
import { CellDisplay, CellEditor, invalidateLinkLabels } from "./cells";
import { AuditList } from "./AuditPanel";
import { t } from "../lib/i18n";

export function RecordModal() {
  const store = useStore();
  const table = activeTable(store);
  const openId = store.openRecordId;
  const [draft, setDraft] = useState<Record<string, CellValue>>({});
  const [editingField, setEditingField] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

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
          <h3>{isNew ? t("rm.newRecord") : t("rm.recordN", { id: row!.id })}</h3>
          <button className="icon-btn" onClick={close}>
            ×
          </button>
        </div>
        <div className="record-fields">
          {table.fields.map((f) => (
            <div key={f.id} className="record-field">
              <div
                className="record-field-label"
                title={f.options.description ? `${fieldTypeLabel(f.type)} — ${f.options.description}` : fieldTypeLabel(f.type)}
              >
                <span className="ftype">{FIELD_TYPE_ICON[f.type]}</span> {f.name}
              </div>
              <div
                className="record-field-value"
                onClick={() => {
                  if (!isComputed(f.type) && f.type !== "checkbox" && f.type !== "rating" && editingField !== f.id) {
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
                    onRate={f.type === "rating" ? (n) => commitField(f, n || null) : undefined}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        {!isNew && showHistory && (
          <div className="record-history">
            <div className="form-label">{t("rm.history")}</div>
            <AuditList tableId={table.id} recordId={row!.id} />
          </div>
        )}
        <div className="modal-actions">
          {!isNew && (
            <button
              className="btn danger"
              onClick={() => {
                if (confirm(t("rm.deleteConfirm"))) {
                  void store.deleteRecords([row!.id]);
                  close();
                }
              }}
            >
              {t("common.delete")}
            </button>
          )}
          {!isNew && (
            <button className="btn" onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? t("rm.hide") : t("rm.historyBtn")}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {isNew ? (
            <>
              <button className="btn" onClick={close}>
                {t("common.cancel")}
              </button>
              <button className="btn primary" onClick={() => void createNow()}>
                {t("rm.create")}
              </button>
            </>
          ) : (
            <button className="btn" onClick={close}>
              {t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
