// Grade tipada (view "grid"): virtualizada, com edição inline por tipo,
// redimensionamento de coluna e menu de campo no cabeçalho.

import { useCallback, useMemo, useRef, useState } from "react";
import { activeTable, activeView, useStore, visibleFields } from "../state/store";
import type { CellValue, Field } from "../lib/types";
import { FIELD_TYPE_ICON } from "../lib/types";
import { CellDisplay, CellEditor, useOutsideClick } from "./cells";
import { FieldEditor } from "./FieldEditor";

const ROW_H = 36;
const OVERSCAN = 10;
const DEFAULT_W = 180;

export function GridView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const fields = visibleFields(table, view);
  const rows = store.rows;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [editing, setEditing] = useState<{ rowId: number; fieldId: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [headerMenu, setHeaderMenu] = useState<string | null>(null); // fieldId
  const [fieldEditor, setFieldEditor] = useState<{ mode: "new" } | { mode: "edit"; field: Field } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(menuRef, () => setHeaderMenu(null));

  const widths = view?.config.widths ?? {};
  const colW = useCallback(
    (f: Field, idx: number) => widths[f.id] ?? (idx === 0 ? 220 : DEFAULT_W),
    [widths]
  );
  const totalW = fields.reduce((acc, f, i) => acc + colW(f, i), 0) + 64 + 40;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const slice = useMemo(() => rows.slice(first, last), [rows, first, last]);

  if (!table || !view) return null;

  const commitCell = (rowId: number, fieldId: string, v: CellValue) => {
    setEditing(null);
    void store.updateCell(rowId, fieldId, v);
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  const startResize = (fieldId: string, startX: number, startW: number) => {
    const onMove = (e: MouseEvent) => {
      const w = Math.max(80, startW + (e.clientX - startX));
      const el = document.querySelector<HTMLElement>(`[data-col="${fieldId}"]`);
      document
        .querySelectorAll<HTMLElement>(`[data-cell-col="${fieldId}"]`)
        .forEach((c) => (c.style.width = w + "px"));
      if (el) el.style.width = w + "px";
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const w = Math.max(80, startW + (e.clientX - startX));
      void store.patchViewConfig({ widths: { ...widths, [fieldId]: w } });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const sortBy = (fieldId: string, desc: boolean) => {
    setHeaderMenu(null);
    void store.patchViewConfig({ sorts: [{ fieldId, desc }] });
  };

  const hideField = (fieldId: string) => {
    setHeaderMenu(null);
    void store.patchViewConfig({ hiddenFields: [...(view.config.hiddenFields ?? []), fieldId] });
  };

  return (
    <div className="grid-wrap">
      <div
        className="grid-scroll"
        ref={(el) => {
          scrollRef.current = el;
          if (el && el.clientHeight !== viewportH) setViewportH(el.clientHeight);
        }}
        onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
      >
        <div style={{ minWidth: totalW }}>
          {/* cabeçalho */}
          <div className="grid-header" style={{ height: ROW_H }}>
            <div className="grid-corner" style={{ width: 64 }}>
              <input
                type="checkbox"
                checked={rows.length > 0 && selected.size === rows.length}
                onChange={toggleAll}
              />
            </div>
            {fields.map((f, i) => (
              <div key={f.id} className="grid-th" data-col={f.id} style={{ width: colW(f, i) }}>
                <button className="grid-th-btn" onClick={() => setHeaderMenu(headerMenu === f.id ? null : f.id)}>
                  <span className="ftype">{FIELD_TYPE_ICON[f.type]}</span>
                  <span className="fname">{f.name}</span>
                </button>
                <div
                  className="col-resize"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    startResize(f.id, e.clientX, colW(f, i));
                  }}
                />
                {headerMenu === f.id && (
                  <div ref={menuRef} className="menu">
                    <button
                      className="menu-item"
                      onClick={() => {
                        setHeaderMenu(null);
                        setFieldEditor({ mode: "edit", field: f });
                      }}
                    >
                      ✏️ Editar campo
                    </button>
                    {f.type !== "formula" && (
                      <>
                        <button className="menu-item" onClick={() => sortBy(f.id, false)}>
                          ↑ Ordenar crescente
                        </button>
                        <button className="menu-item" onClick={() => sortBy(f.id, true)}>
                          ↓ Ordenar decrescente
                        </button>
                      </>
                    )}
                    {i !== 0 && (
                      <button className="menu-item" onClick={() => hideField(f.id)}>
                        🙈 Ocultar campo
                      </button>
                    )}
                    {table.fields.length > 1 && (
                      <button
                        className="menu-item danger"
                        onClick={() => {
                          setHeaderMenu(null);
                          if (confirm(`Excluir o campo "${f.name}" e todos os seus dados?`)) {
                            void store.deleteField(f.id);
                          }
                        }}
                      >
                        🗑 Excluir campo
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="grid-th grid-th-add" style={{ width: 40 }}>
              <button className="grid-th-btn" title="Novo campo" onClick={() => setFieldEditor({ mode: "new" })}>
                +
              </button>
            </div>
          </div>

          {/* corpo virtualizado */}
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {slice.map((r, i) => {
              const rowIdx = first + i;
              return (
                <div
                  key={r.id}
                  className={"grid-row" + (selected.has(r.id) ? " sel" : "")}
                  style={{ transform: `translateY(${rowIdx * ROW_H}px)`, height: ROW_H }}
                >
                  <div className="grid-rowno" style={{ width: 64 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        setSelected(next);
                      }}
                    />
                    <span className="rowno">{rowIdx + 1}</span>
                    <button className="expand" title="Abrir registro" onClick={() => store.setOpenRecord(r.id)}>
                      ⤢
                    </button>
                  </div>
                  {fields.map((f, ci) => {
                    const isEditing = editing?.rowId === r.id && editing.fieldId === f.id;
                    return (
                      <div
                        key={f.id}
                        className={"grid-td" + (isEditing ? " editing" : "")}
                        data-cell-col={f.id}
                        style={{ width: colW(f, ci) }}
                        onDoubleClick={() => {
                          if (f.type !== "formula" && f.type !== "checkbox") {
                            setEditing({ rowId: r.id, fieldId: f.id });
                          }
                        }}
                      >
                        {isEditing ? (
                          <CellEditor
                            field={f}
                            value={r.cells[f.id] ?? null}
                            tables={store.schema?.tables ?? []}
                            commit={(v) => commitCell(r.id, f.id, v)}
                            cancel={() => setEditing(null)}
                          />
                        ) : (
                          <CellDisplay
                            field={f}
                            value={r.cells[f.id] ?? null}
                            row={r}
                            table={table}
                            tables={store.schema?.tables ?? []}
                            onToggle={f.type === "checkbox" ? (v) => commitCell(r.id, f.id, v) : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* nova linha */}
          <button className="grid-addrow" style={{ width: Math.max(totalW, 300) }} onClick={() => void store.addRecord()}>
            + Novo registro
          </button>
        </div>
      </div>

      {/* barra de seleção */}
      {selected.size > 0 && (
        <div className="selbar">
          <span>
            {selected.size} selecionado{selected.size > 1 ? "s" : ""}
          </span>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Excluir ${selected.size} registro(s)?`)) {
                void store.deleteRecords(Array.from(selected));
                setSelected(new Set());
              }
            }}
          >
            Excluir
          </button>
          <button className="btn" onClick={() => setSelected(new Set())}>
            Limpar seleção
          </button>
        </div>
      )}

      {fieldEditor && (
        <FieldEditor
          mode={fieldEditor.mode}
          field={fieldEditor.mode === "edit" ? fieldEditor.field : undefined}
          onClose={() => setFieldEditor(null)}
        />
      )}
    </div>
  );
}
