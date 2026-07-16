// Grade tipada (view "grid"): virtualizada, edição inline por tipo, navegação
// por teclado, seleção retangular (Shift), copiar/colar TSV, agrupamento
// colapsável, rodapé de agregação, cor de linha por select, redimensionar e
// reordenar colunas por drag, menu de campo e menu de contexto por linha.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeTable, activeView, useStore, visibleFields } from "../state/store";
import * as api from "../lib/backend";
import type { CellValue, Field, RecordRow, AggKind } from "../lib/types";
import { FIELD_TYPE_ICON, choiceColor, isComputed } from "../lib/types";
import { CellDisplay, CellEditor, formatNumber, invalidateLinkLabels, plainCellText, useOutsideClick } from "./cells";
import { missingChoiceNames, newChoiceId, parseTsv, textToCell, toTsv } from "../lib/clipboard";
import { FieldEditor } from "./FieldEditor";
import { t as tr, localeTag } from "../lib/i18n";

const ROW_H = 36;
const GROUP_H = 34;
const OVERSCAN = 10;
const DEFAULT_W = 180;

/** Tipos editáveis direto com o teclado (abrem o editor ao digitar). */
const TYPE_STARTS_EDIT = new Set(["text", "long_text", "number", "url", "email", "phone"]);

/** Tipos que fazem sentido como grupo na grade. */
export const GROUPABLE_TYPES = new Set(["text", "number", "checkbox", "date", "select", "rating", "url", "email", "phone", "custom"]);

interface Cur {
  r: number;
  c: number;
}

type DisplayItem =
  | { kind: "header"; key: string; label: string; color?: string; count: number; top: number }
  | { kind: "row"; row: RecordRow; flatIdx: number; top: number };

/** Rótulo/cor/chave de grupo de uma linha. */
function groupOf(f: Field, r: RecordRow): { key: string; label: string; color?: string } {
  const v = r.cells[f.id];
  if (f.type === "select") {
    const idx = (f.options.choices ?? []).findIndex((c) => c.id === v);
    if (idx >= 0) {
      const c = f.options.choices![idx];
      return { key: c.id, label: c.name, color: choiceColor(c, idx) };
    }
    return { key: "", label: tr("common.emptyValue") };
  }
  if (f.type === "checkbox") return v ? { key: "1", label: tr("grid.checkedLabel") } : { key: "0", label: tr("grid.uncheckedLabel") };
  const s = plainCellText(f, v ?? null, []);
  return s ? { key: s, label: s } : { key: "", label: tr("common.emptyValue") };
}

export function GridView() {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const fields = visibleFields(table, view);
  const rows = store.rows;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [editing, setEditing] = useState<{ rowId: number; fieldId: string; seed?: string } | null>(null);
  const [cursor, setCursor] = useState<Cur | null>(null);
  const [anchor, setAnchor] = useState<Cur | null>(null); // seleção retangular
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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

  const groupField = useMemo(() => {
    const id = view?.config.groupField;
    if (!id || !table) return undefined;
    const f = table.fields.find((x) => x.id === id);
    return f && GROUPABLE_TYPES.has(f.type) ? f : undefined;
  }, [view?.config.groupField, table]);

  const colorField = useMemo(() => {
    const id = view?.config.colorField;
    if (!id || !table) return undefined;
    const f = table.fields.find((x) => x.id === id);
    return f && f.type === "select" ? f : undefined;
  }, [view?.config.colorField, table]);

  // linhas na ordem de exibição (com grupos e colapso aplicados) + posições
  const { items, flatRows, flatTops, totalH } = useMemo(() => {
    if (!groupField) {
      const items: DisplayItem[] = rows.map((row, i) => ({ kind: "row", row, flatIdx: i, top: i * ROW_H }));
      return { items, flatRows: rows, flatTops: rows.map((_, i) => i * ROW_H), totalH: rows.length * ROW_H };
    }
    const buckets = new Map<string, { label: string; color?: string; rows: RecordRow[] }>();
    for (const r of rows) {
      const g = groupOf(groupField, r);
      let b = buckets.get(g.key);
      if (!b) {
        b = { label: g.label, color: g.color, rows: [] };
        buckets.set(g.key, b);
      }
      b.rows.push(r);
    }
    // ordem: select segue a ordem das opções; número/avaliação numérica; resto alfabética; vazio no fim
    let keys = Array.from(buckets.keys());
    if (groupField.type === "select") {
      const order = new Map((groupField.options.choices ?? []).map((c, i) => [c.id, i]));
      keys.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
    } else if (groupField.type === "number" || groupField.type === "rating") {
      keys.sort((a, b) => parseFloat(a.replace(",", ".")) - parseFloat(b.replace(",", ".")));
    } else {
      keys.sort((a, b) => a.localeCompare(b, localeTag()));
    }
    keys = [...keys.filter((k) => k !== ""), ...keys.filter((k) => k === "")];

    const items: DisplayItem[] = [];
    const flatRows: RecordRow[] = [];
    const flatTops: number[] = [];
    let top = 0;
    for (const key of keys) {
      const b = buckets.get(key)!;
      items.push({ kind: "header", key, label: b.label, color: b.color, count: b.rows.length, top });
      top += GROUP_H;
      if (!collapsed.has(key)) {
        for (const row of b.rows) {
          items.push({ kind: "row", row, flatIdx: flatRows.length, top });
          flatTops.push(top);
          flatRows.push(row);
          top += ROW_H;
        }
      } else {
        // linhas colapsadas saem da navegação, mas continuam nos dados
      }
    }
    return { items, flatRows, flatTops, totalH: top };
  }, [rows, groupField, collapsed]);

  // fatia visível (itens têm top monotônico — busca binária)
  const slice = useMemo(() => {
    const lo = scrollTop - OVERSCAN * ROW_H;
    const hi = scrollTop + viewportH + OVERSCAN * ROW_H;
    let a = 0;
    let b = items.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (items[m].top + ROW_H < lo) a = m + 1;
      else b = m;
    }
    const out: DisplayItem[] = [];
    for (let i = a; i < items.length && items[i].top <= hi; i++) out.push(items[i]);
    return out;
  }, [items, scrollTop, viewportH]);

  // mantém o cursor dentro dos limites quando linhas/campos mudam
  useEffect(() => {
    if (!cursor) return;
    if (cursor.r >= flatRows.length || cursor.c >= fields.length) {
      const ok = flatRows.length && fields.length;
      setCursor(ok ? { r: Math.min(cursor.r, flatRows.length - 1), c: Math.min(cursor.c, fields.length - 1) } : null);
      setAnchor(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatRows.length, fields.length]);

  if (!table || !view) return null;

  const commitCell = (rowId: number, fieldId: string, v: CellValue) => {
    setEditing(null);
    scrollRef.current?.focus({ preventScroll: true });
    void store.updateCell(rowId, fieldId, v);
  };

  const scrollCursorIntoView = (r: number) => {
    const el = scrollRef.current;
    if (!el || flatTops[r] == null) return;
    const top = flatTops[r];
    const headH = ROW_H;
    if (top < el.scrollTop + headH) el.scrollTop = Math.max(0, top - headH);
    else if (top + ROW_H > el.scrollTop + el.clientHeight - ROW_H) {
      el.scrollTop = top + ROW_H - el.clientHeight + ROW_H;
    }
  };

  const moveCursor = (dr: number, dc: number, extend = false) => {
    if (!flatRows.length || !fields.length) return;
    const cur = cursor ?? { r: 0, c: 0 };
    if (extend && !anchor) setAnchor(cur);
    if (!extend) setAnchor(null);
    const r = Math.max(0, Math.min(flatRows.length - 1, cur.r + dr));
    const c = Math.max(0, Math.min(fields.length - 1, cur.c + dc));
    setCursor({ r, c });
    scrollCursorIntoView(r);
  };

  /** Retângulo selecionado (inclusive), ou a célula do cursor. */
  const selRect = (): { r1: number; r2: number; c1: number; c2: number } | null => {
    if (!cursor) return null;
    const a = anchor ?? cursor;
    return {
      r1: Math.min(a.r, cursor.r),
      r2: Math.max(a.r, cursor.r),
      c1: Math.min(a.c, cursor.c),
      c2: Math.max(a.c, cursor.c),
    };
  };

  const startEdit = (r: number, c: number, seed?: string) => {
    const row = flatRows[r];
    const f = fields[c];
    if (!row || !f || isComputed(f.type)) return;
    if (f.type === "checkbox") {
      void store.updateCell(row.id, f.id, !row.cells[f.id]);
      return;
    }
    setEditing({ rowId: row.id, fieldId: f.id, seed });
  };

  // ---------------------------------------------------------------------------
  // copiar/colar
  // ---------------------------------------------------------------------------

  const copySelection = async () => {
    const rect = selRect();
    if (!rect) return;
    const tables = store.schema?.tables ?? [];
    const matrix: string[][] = [];
    for (let r = rect.r1; r <= rect.r2; r++) {
      const row = flatRows[r];
      if (!row) continue;
      matrix.push(fields.slice(rect.c1, rect.c2 + 1).map((f) => plainCellText(f, row.cells[f.id] ?? null, tables)));
    }
    const tsv = toTsv(matrix);
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // fallback (clipboard API bloqueada): textarea temporário
      const ta = document.createElement("textarea");
      ta.value = tsv;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  };

  const pasteMatrix = async (matrix: string[][]) => {
    const rect = selRect();
    if (!rect || !matrix.length) return;
    // colar 1 célula numa seleção maior repete o valor (como no Excel)
    if (matrix.length === 1 && matrix[0].length === 1 && (rect.r2 > rect.r1 || rect.c2 > rect.c1)) {
      const v = matrix[0][0];
      matrix = Array.from({ length: rect.r2 - rect.r1 + 1 }, () =>
        Array.from({ length: rect.c2 - rect.c1 + 1 }, () => v)
      );
    }
    const startR = rect.r1;
    const cols = fields.slice(rect.c1, rect.c1 + Math.max(...matrix.map((m) => m.length)));

    // cria opções de select que ainda não existem (uma atualização por campo)
    const choiceMap = new Map<string, { id: string; name: string; color: string }[]>();
    for (let j = 0; j < cols.length; j++) {
      const f = cols[j];
      if (f.type !== "select" && f.type !== "multi_select") continue;
      const texts = matrix.map((m) => m[j] ?? "").filter(Boolean);
      const missing = missingChoiceNames(f, texts);
      const all = [...(f.options.choices ?? []), ...missing.map((n) => ({ id: newChoiceId(), name: n, color: "" }))];
      choiceMap.set(f.id, all);
      if (missing.length) {
        await store.updateField(f.id, undefined, { ...f.options, choices: all });
      }
    }

    const updates: { id: number; cells: Record<string, CellValue> }[] = [];
    const extras: Record<string, CellValue>[] = [];
    matrix.forEach((rowTexts, i) => {
      const cells: Record<string, CellValue> = {};
      rowTexts.forEach((t, j) => {
        const f = cols[j];
        if (!f) return;
        const v = textToCell(f, t, choiceMap.get(f.id));
        if (v !== undefined) cells[f.id] = v;
      });
      if (!Object.keys(cells).length) return;
      const target = flatRows[startR + i];
      if (target) updates.push({ id: target.id, cells });
      else extras.push(cells);
    });
    if (updates.length) await store.updateRecordsBulk(updates);
    if (extras.length) await store.createRecordsBulk(extras);
    invalidateLinkLabels(table.id);
  };

  const clearSelection = () => {
    const rect = selRect();
    if (!rect) return;
    const updates: { id: number; cells: Record<string, CellValue> }[] = [];
    for (let r = rect.r1; r <= rect.r2; r++) {
      const row = flatRows[r];
      if (!row) continue;
      const cells: Record<string, CellValue> = {};
      for (let c = rect.c1; c <= rect.c2; c++) {
        const f = fields[c];
        if (!f || isComputed(f.type)) continue;
        cells[f.id] = f.type === "checkbox" ? false : null;
      }
      if (Object.keys(cells).length) updates.push({ id: row.id, cells });
    }
    if (updates.length) void store.updateRecordsBulk(updates);
  };

  // ---------------------------------------------------------------------------
  // teclado
  // ---------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    // enquanto edita, o editor cuida das teclas; só o Enter "vaza" pra descer a célula
    if (editing) {
      if (e.key === "Enter" && !e.shiftKey) moveCursor(1, 0);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        void copySelection();
      } else if (k === "a") {
        e.preventDefault();
        if (flatRows.length && fields.length) {
          setAnchor({ r: 0, c: 0 });
          setCursor({ r: flatRows.length - 1, c: fields.length - 1 });
        }
      }
      // Ctrl+V chega pelo evento onPaste; undo/redo ficam no App
      return;
    }
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1, 0, e.shiftKey);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1, 0, e.shiftKey);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveCursor(0, -1, e.shiftKey);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveCursor(0, 1, e.shiftKey);
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
      case "Backspace":
        e.preventDefault();
        clearSelection();
        break;
      case "Escape":
        setCursor(null);
        setAnchor(null);
        setSelected(new Set());
        break;
      default:
        // digitar já abre o editor com o caractere (texto/número/url…)
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
    if (selected.size === flatRows.length) setSelected(new Set());
    else setSelected(new Set(flatRows.map((r) => r.id)));
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

  // ---------------------------------------------------------------------------
  // rodapé de agregação
  // ---------------------------------------------------------------------------

  const aggs = view.config.aggs ?? {};
  const isNumericField = (f: Field) => f.type === "number" || f.type === "rating";

  const cycleAgg = (f: Field) => {
    const order: (AggKind | undefined)[] = isNumericField(f)
      ? [undefined, "filled", "sum", "avg", "min", "max"]
      : [undefined, "filled"];
    const cur = order.indexOf(aggs[f.id]);
    const next = order[(cur + 1) % order.length];
    const nextAggs = { ...aggs };
    if (next) nextAggs[f.id] = next;
    else delete nextAggs[f.id];
    void store.patchViewConfig({ aggs: nextAggs });
  };

  const hasAggs = Object.keys(aggs).some((id) => fields.some((f) => f.id === id));

  // Agregações no SQL: valem sobre a tabela INTEIRA (com os filtros/busca da
  // view), não só sobre as linhas carregadas — escala pra centenas de milhares.
  const [aggData, setAggData] = useState<Record<string, number | null>>({});
  const aggKey = JSON.stringify(aggs);
  useEffect(() => {
    if (!hasAggs || !table) {
      setAggData({});
      return;
    }
    const specs = Object.entries(aggs)
      .filter(([id]) => fields.some((f) => f.id === id))
      .map(([fieldId, kind]) => ({ fieldId, kind: kind as string }));
    let dead = false;
    api
      .recordsAggregate(table.id, specs, {
        filters: view.config.filters ?? [],
        search: store.search || undefined,
      })
      .then((d) => !dead && setAggData(d))
      .catch(() => {});
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggKey, table?.id, store.search, JSON.stringify(view.config.filters ?? []), store.total]);

  const aggValue = (f: Field, kind: AggKind): string => {
    const raw = aggData[`${f.id}:${kind}`];
    if (kind === "filled") return tr("grid.aggFilled", { n: raw ?? 0 });
    if (raw == null) return "—";
    const label = { sum: tr("grid.aggSum"), avg: tr("grid.aggAvg"), min: tr("grid.aggMin"), max: tr("grid.aggMax") }[kind];
    return `${label} ${formatNumber(Math.round(raw * 1e6) / 1e6, f.options)}`;
  };
  const rect = selRect();

  const rowColor = (r: RecordRow): string | undefined => {
    if (!colorField) return undefined;
    const v = r.cells[colorField.id];
    const idx = (colorField.options.choices ?? []).findIndex((c) => c.id === v);
    return idx >= 0 ? choiceColor(colorField.options.choices![idx], idx) : undefined;
  };

  return (
    <div className="grid-wrap">
      <div
        className="grid-scroll"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (editing || !cursor) return;
          const text = e.clipboardData.getData("text/plain");
          if (!text) return;
          e.preventDefault();
          void pasteMatrix(parseTsv(text));
        }}
        ref={(el) => {
          scrollRef.current = el;
          if (el && el.clientHeight !== viewportH) setViewportH(el.clientHeight);
        }}
        onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
      >
        <div style={{ minWidth: totalW }}>
          {/* cabeçalho */}
          <div className="grid-header" style={{ height: ROW_H }}>
            <div className="grid-corner sticky-col" style={{ width: 64 }}>
              <input
                type="checkbox"
                checked={flatRows.length > 0 && selected.size === flatRows.length}
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
                  title={f.options.description || undefined}
                  onDragStart={(e) => {
                    setDragCol(f.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragCol(null)}
                  onClick={() => setHeaderMenu(headerMenu === f.id ? null : f.id)}
                >
                  <span className="ftype">{FIELD_TYPE_ICON[f.type]}</span>
                  <span className="fname">{f.name}</span>
                  {f.options.description && <span className="fdesc">ⓘ</span>}
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
                      {tr("grid.editField")}
                    </button>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setHeaderMenu(null);
                        void store.duplicateField(f.id);
                      }}
                    >
                      {tr("grid.dupField")}
                    </button>
                    {!isComputed(f.type) && (
                      <>
                        <button className="menu-item" onClick={() => sortBy(f.id, false)}>
                          {tr("grid.sortAsc")}
                        </button>
                        <button className="menu-item" onClick={() => sortBy(f.id, true)}>
                          {tr("grid.sortDesc")}
                        </button>
                      </>
                    )}
                    {GROUPABLE_TYPES.has(f.type) && (
                      <button
                        className="menu-item"
                        onClick={() => {
                          setHeaderMenu(null);
                          void store.patchViewConfig({
                            groupField: view.config.groupField === f.id ? undefined : f.id,
                          });
                        }}
                      >
                        {view.config.groupField === f.id ? tr("grid.ungroup") : tr("grid.groupByThis")}
                      </button>
                    )}
                    {i !== 0 && (
                      <button className="menu-item" onClick={() => hideField(f.id)}>
                        {tr("grid.hideField")}
                      </button>
                    )}
                    {table.fields.length > 1 && (
                      <button
                        className="menu-item danger"
                        onClick={() => {
                          setHeaderMenu(null);
                          if (confirm(tr("grid.deleteFieldConfirm", { name: f.name }))) {
                            void store.deleteField(f.id);
                          }
                        }}
                      >
                        {tr("grid.deleteField")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="grid-th grid-th-add" style={{ width: 40 }}>
              <button className="grid-th-btn" title={tr("grid.newField")} onClick={() => setFieldEditor({ mode: "new" })}>
                +
              </button>
            </div>
          </div>

          {/* corpo virtualizado (linhas e cabeçalhos de grupo) */}
          <div style={{ height: totalH, position: "relative" }}>
            {slice.map((it) => {
              if (it.kind === "header") {
                const isCollapsed = collapsed.has(it.key);
                return (
                  <div
                    key={"g" + it.key}
                    className="grid-group"
                    style={{ top: it.top, height: GROUP_H }}
                    onClick={() => {
                      const next = new Set(collapsed);
                      if (isCollapsed) next.delete(it.key);
                      else next.add(it.key);
                      setCollapsed(next);
                    }}
                  >
                    <span className="grid-group-caret">{isCollapsed ? "▸" : "▾"}</span>
                    {it.color && <span className="choice-dot" style={{ background: it.color }} />}
                    <span className="grid-group-label">{it.label}</span>
                    <span className="grid-group-count">{it.count}</span>
                  </div>
                );
              }
              const r = it.row;
              const rowIdx = it.flatIdx;
              const color = rowColor(r);
              return (
                <div
                  key={r.id}
                  className={"grid-row" + (selected.has(r.id) ? " sel" : "")}
                  style={{
                    top: it.top,
                    height: ROW_H,
                    boxShadow: color ? `inset 3px 0 0 ${color}` : undefined,
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, rowId: r.id });
                  }}
                >
                  <div className="grid-rowno sticky-col" style={{ width: 64 }}>
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
                    <button className="expand" title={tr("grid.openRecord")} onClick={() => store.setOpenRecord(r.id)}>
                      ⤢
                    </button>
                  </div>
                  {fields.map((f, ci) => {
                    const isEditing = editing?.rowId === r.id && editing.fieldId === f.id;
                    const isCursor = cursor?.r === rowIdx && cursor.c === ci && !isEditing;
                    const inSel =
                      !!rect &&
                      !!anchor &&
                      rowIdx >= rect.r1 &&
                      rowIdx <= rect.r2 &&
                      ci >= rect.c1 &&
                      ci <= rect.c2;
                    return (
                      <div
                        key={f.id}
                        className={
                          "grid-td" + (isEditing ? " editing" : "") + (isCursor ? " cursor" : "") + (inSel ? " insel" : "")
                        }
                        data-cell-col={f.id}
                        style={{ width: colW(f, ci) }}
                        onClick={(e) => {
                          if (e.shiftKey && cursor) {
                            if (!anchor) setAnchor(cursor);
                            setCursor({ r: rowIdx, c: ci });
                          } else {
                            setAnchor(null);
                            setCursor({ r: rowIdx, c: ci });
                          }
                        }}
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
                            onRate={f.type === "rating" ? (n) => commitCell(r.id, f.id, n || null) : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* estado vazio + nova linha + indicador de carregamento incremental */}
          {rows.length === 0 && !store.loading && (
            <div className="grid-empty muted">
              {store.search || (view.config.filters ?? []).length
                ? tr("grid.emptyFiltered")
                : tr("grid.emptyTable")}
            </div>
          )}
          <button className="grid-addrow" style={{ width: Math.max(totalW, 300) }} onClick={() => void store.addRecord()}>
            {tr("common.newRecord")}
          </button>
          {rows.length < store.total && (
            <div className="grid-loading muted">{tr("grid.loadingMore", { n: rows.length, total: store.total })}</div>
          )}

          {/* rodapé de agregação (sticky) */}
          <div className="grid-footer" style={{ minWidth: totalW }}>
            <div className="grid-footer-cell sticky-col" style={{ width: 64 }}>
              {hasAggs ? "Σ" : ""}
            </div>
            {fields.map((f, i) => {
              const kind = aggs[f.id];
              return (
                <button
                  key={f.id}
                  className={"grid-footer-cell agg" + (kind ? " on" : "")}
                  style={{ width: colW(f, i) }}
                  title={tr("grid.aggTitle")}
                  onClick={() => cycleAgg(f)}
                >
                  {kind ? aggValue(f, kind) : "+"}
                </button>
              );
            })}
            <div className="grid-footer-cell" style={{ width: 40 }} />
          </div>
        </div>
      </div>

      {/* barra de seleção */}
      {selected.size > 0 && (
        <div className="selbar">
          <span>
            {tr(selected.size > 1 ? "grid.selectedMany" : "grid.selectedOne", { n: selected.size })}
          </span>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(tr("grid.deleteRecordsConfirm", { n: selected.size }))) {
                void store.deleteRecords(Array.from(selected));
                setSelected(new Set());
              }
            }}
          >
            {tr("common.delete")}
          </button>
          <button className="btn" onClick={() => setSelected(new Set())}>
            {tr("grid.clearSel")}
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
            {tr("grid.ctxOpen")}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              void store.duplicateRecord(ctxMenu.rowId);
              setCtxMenu(null);
            }}
          >
            {tr("grid.ctxDup")}
          </button>
          <button
            className="menu-item danger"
            onClick={() => {
              void store.deleteRecords([ctxMenu.rowId]);
              setCtxMenu(null);
            }}
          >
            {tr("grid.ctxDelete")}
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
