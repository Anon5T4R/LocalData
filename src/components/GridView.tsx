// Grade tipada (view "grid"): virtualizada, edição inline por tipo, navegação
// por teclado (setas/Enter/Tab/Delete), redimensionar e reordenar colunas por
// drag, menu de campo no cabeçalho e menu de contexto por linha.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeTable, activeView, useStore, visibleFields } from "../state/store";
import type { CellValue, Field } from "../lib/types";
import { FIELD_TYPE_ICON } from "../lib/types";
import { CellDisplay, CellEditor, useOutsideClick } from "./cells";
import { FieldEditor } from "./FieldEditor";

const ROW_H = 36;
const OVERSCAN = 10;
const DEFAULT_W = 180;

/** Tipos editáveis direto com o teclado (abrem o editor ao digitar). */
const TYPE_STARTS_EDIT = new Set(["text", "long_text", "number"]);

export function GridView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const fields = visibleFields(table, view);
  const rows = store.rows;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [editing, setEditing] = useState<{ rowId: number; fieldId: string; seed?: string } | null>(null);
  const [cursor, setCursor] = useState<{ r: number; c: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [headerMenu, setHeaderMenu] = useState<string | null>(null); // fieldId
  const [fieldEditor, setFieldEditor] = useState<{ mode: "new" } | { mode: "edit"; field: Field } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; rowId: number } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  useOutsideClick(menuRef, () => setHeaderMenu(null));
  useOutsideClick(ctxRef, () => setCtxMenu(null));

  const widths = view?.config.widths ?? {};
  const colW = useCallback(
    (f: Field, idx: number) => widths[f.id] ?? (idx === 0 ? 220 : DEFAULT_W),
    [widths]
  );
  const totalW = fields.reduce((acc, f, i) => acc + colW(f, i), 0) + 64 + 40;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const slice = useMemo(() => rows.slice(first, last), [rows, first, last]);

  // mantém o cursor dentro dos limites quando linhas/campos mudam
  useEffect(() => {
    if (!cursor) return;
    if (cursor.r >= rows.length || cursor.c >= fields.length) {
      setCursor(rows.length && fields.length ? { r: Math.min(cursor.r, rows.length - 1), c: Math.min(cursor.c, fields.length - 1) } : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, fields.length]);

  if (!table || !view) return null;

  const commitCell = (rowId: number, fieldId: string, v: CellValue) => {
    setEditing(null);
    scrollRef.current?.focus({ preventScroll: true });
    void store.updateCell(rowId, fieldId, v);
  };

  const scrollCursorIntoView = (r: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = r * ROW_H;
    const headH = ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - headH) {
      el.scrollTop = top + ROW_H - el.clientHeight + headH;
    }
  };

  const moveCursor = (dr: number, dc: number) => {
    if (!rows.length || !fields.length) return;
    const cur = cursor ?? { r: 0, c: 0 };
    const r = Math.max(0, Math.min(rows.length - 1, cur.r + dr));
    const c = Math.max(0, Math.min(fields.length - 1, cur.c + dc));
    setCursor({ r, c });
    scrollCursorIntoView(r);
  };

  const startEdit = (r: number, c: number, seed?: string) => {
    const row = rows[r];
    const f = fields[c];
    if (!row || !f || f.type === "formula") return;
    if (f.type === "checkbox") {
      void store.updateCell(row.id, f.id, !row.cells[f.id]);
      return;
    }
    setEditing({ rowId: row.id, fieldId: f.id, seed });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // enquanto edita, o editor cuida das teclas; só o Enter "vaza" pra descer a célula
    if (editing) {
      if (e.key === "Enter" && !e.shiftKey) moveCursor(1, 0);
      return;
    }
    if (e.ctrlKey || e.metaKey) return; // atalhos globais (undo etc.) ficam no App
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1, 0);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1, 0);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveCursor(0, -1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveCursor(0, 1);
        break;
      case "Tab":
        e.preventDefault();
        moveCursor(0, e.shiftKey ? -1 : 1);
        break;
      case "Enter":
      case "F2":
        e.preventDefault();
        if (cursor) startEdit(cursor.r, cursor.c);
        break;
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        if (!cursor) break;
        const row = rows[cursor.r];
        const f = fields[cursor.c];
        if (row && f && f.type !== "formula") {
          void store.updateCell(row.id, f.id, f.type === "checkbox" ? false : null);
        }
        break;
      }
      case "Escape":
        setCursor(null);
        setSelected(new Set());
        break;
      default:
        // digitar já abre o editor com o caractere (texto/número/data)
        if (cursor && e.key.length === 1 && !e.altKey) {
          const f = fields[cursor.c];
          if (f && TYPE_STARTS_EDIT.has(f.type)) {
            e.preventDefault();
            startEdit(cursor.r, cursor.c, e.key);
          }
        }
    }
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

  const dropColumn = (targetId: string) => {
    if (!dragCol || dragCol === targetId) {
      setDragCol(null);
      return;
    }
    // reordena na lista COMPLETA de campos (ocultos mantêm a posição relativa)
    const all = table.fields.map((f) => f.id);
    const from = all.indexOf(dragCol);
    const to = all.indexOf(targetId);
    if (from >= 0 && to >= 0) {
      all.splice(to, 0, all.splice(from, 1)[0]);
      void store.reorderFields(all);
    }
    setDragCol(null);
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
        tabIndex={0}
        onKeyDown={onKeyDown}
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
              <div
                key={f.id}
                className={"grid-th" + (dragCol === f.id ? " dragging" : "")}
                data-col={f.id}
                style={{ width: colW(f, i) }}
                onDragOver={(e) => dragCol && e.preventDefault()}
                onDrop={() => dropColumn(f.id)}
              >
                <button
                  className="grid-th-btn"
                  draggable
                  onDragStart={(e) => {
                    setDragCol(f.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragCol(null)}
                  onClick={() => setHeaderMenu(headerMenu === f.id ? null : f.id)}
                >
                  <span className="ftype">{FIELD_TYPE_ICON[f.type]}</span>
                  <span className="fname">{f.name}</span>
                </button>
                <div
                  className="col-resize"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, rowId: r.id });
                  }}
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
                    const isCursor = cursor?.r === rowIdx && cursor.c === ci && !isEditing;
                    return (
                      <div
                        key={f.id}
                        className={"grid-td" + (isEditing ? " editing" : "") + (isCursor ? " cursor" : "")}
                        data-cell-col={f.id}
                        style={{ width: colW(f, ci) }}
                        onClick={() => setCursor({ r: rowIdx, c: ci })}
                        onDoubleClick={() => startEdit(rowIdx, ci)}
                      >
                        {isEditing ? (
                          <CellEditor
                            field={f}
                            value={editing.seed !== undefined ? editing.seed : r.cells[f.id] ?? null}
                            tables={store.schema?.tables ?? []}
                            commit={(v) => commitCell(r.id, f.id, v)}
                            cancel={() => {
                              setEditing(null);
                              scrollRef.current?.focus({ preventScroll: true });
                            }}
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

          {/* nova linha + indicador de carregamento incremental */}
          <button className="grid-addrow" style={{ width: Math.max(totalW, 300) }} onClick={() => void store.addRecord()}>
            + Novo registro
          </button>
          {rows.length < store.total && (
            <div className="grid-loading muted">carregando {rows.length} de {store.total}…</div>
          )}
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

      {/* menu de contexto da linha */}
      {ctxMenu && (
        <div ref={ctxRef} className="menu ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            className="menu-item"
            onClick={() => {
              store.setOpenRecord(ctxMenu.rowId);
              setCtxMenu(null);
            }}
          >
            ⤢ Abrir registro
          </button>
          <button
            className="menu-item"
            onClick={() => {
              void store.duplicateRecord(ctxMenu.rowId);
              setCtxMenu(null);
            }}
          >
            ⧉ Duplicar
          </button>
          <button
            className="menu-item danger"
            onClick={() => {
              void store.deleteRecords([ctxMenu.rowId]);
              setCtxMenu(null);
            }}
          >
            🗑 Excluir
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
