// Kanban: colunas = opções de um campo select; arrastar move o cartão
// (atualiza o registro de verdade).

import { useState } from "react";
import { activeTable, activeView, useStore } from "../state/store";
import type { Choice, RecordRow } from "../lib/types";
import { choiceColor } from "../lib/types";
import { CellDisplay } from "./cells";

const NONE = "__none__";

export function KanbanView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  if (!table || !view) return null;

  const groupField = table.fields.find((f) => f.id === view.config.groupField && f.type === "select");
  const selectFields = table.fields.filter((f) => f.type === "select");

  if (!groupField) {
    return (
      <div className="view-setup">
        <p>O kanban agrupa por um campo de seleção única.</p>
        {selectFields.length ? (
          <select
            className="input"
            value=""
            onChange={(e) => e.target.value && void store.patchViewConfig({ groupField: e.target.value })}
          >
            <option value="">Escolher campo…</option>
            {selectFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted">Crie um campo do tipo "Seleção única" primeiro.</p>
        )}
      </div>
    );
  }

  const choices = groupField.options.choices ?? [];
  const cols: { key: string; choice: Choice | null }[] = [
    ...choices.map((c) => ({ key: c.id, choice: c })),
    { key: NONE, choice: null },
  ];
  const byCol = new Map<string, RecordRow[]>();
  for (const c of cols) byCol.set(c.key, []);
  for (const r of store.rows) {
    const v = r.cells[groupField.id];
    const key = typeof v === "string" && byCol.has(v) ? v : NONE;
    byCol.get(key)!.push(r);
  }

  const primary = table.fields[0];
  const cardFields = table.fields.filter((f) => f.id !== primary?.id && f.id !== groupField.id).slice(0, 3);

  const dropOn = (colKey: string) => {
    setOverCol(null);
    if (dragId == null) return;
    const value = colKey === NONE ? null : colKey;
    void store.updateCell(dragId, groupField.id, value);
    setDragId(null);
  };

  return (
    <div className="kanban">
      {cols.map(({ key, choice }) => {
        const items = byCol.get(key)!;
        if (!choice && !items.length) return null;
        const idx = choice ? choices.findIndex((c) => c.id === choice.id) : -1;
        return (
          <div
            key={key}
            className={"kanban-col" + (overCol === key ? " over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(key);
            }}
            onDragLeave={() => setOverCol((c) => (c === key ? null : c))}
            onDrop={() => dropOn(key)}
          >
            <div className="kanban-col-head">
              {choice ? (
                <span className="chip" style={{ background: choiceColor(choice, idx) }}>
                  {choice.name}
                </span>
              ) : (
                <span className="chip chip-muted">Sem valor</span>
              )}
              <span className="count">{items.length}</span>
            </div>
            <div className="kanban-cards">
              {items.map((r) => (
                <div
                  key={r.id}
                  className="kanban-card"
                  draggable
                  onDragStart={() => setDragId(r.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => store.setOpenRecord(r.id)}
                >
                  <div className="card-title">
                    {primary && r.cells[primary.id] != null && r.cells[primary.id] !== ""
                      ? String(r.cells[primary.id])
                      : `#${r.id}`}
                  </div>
                  {cardFields.map((f) => {
                    const v = r.cells[f.id];
                    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
                    return (
                      <div key={f.id} className="card-line">
                        <CellDisplay field={f} value={v} row={r} table={table} tables={store.schema?.tables ?? []} />
                      </div>
                    );
                  })}
                </div>
              ))}
              <button
                className="kanban-add"
                onClick={() => {
                  void store
                    .addRecord(key === NONE ? {} : { [groupField.id]: key })
                    .then((id) => id != null && store.setOpenRecord(id));
                }}
              >
                + Novo
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
