// Barra de ferramentas da view: novo registro, filtros, ordenação, campos
// ocultos, importação/exportação e busca.

import { useRef, useState } from "react";
import { activeTable, activeView, useStore } from "../state/store";
import type { FilterSpec, SortSpec } from "../lib/types";
import { FIELD_TYPE_ICON, opsForType } from "../lib/types";
import { useOutsideClick } from "./cells";
import { exportTable, importFile } from "../lib/importer";

type Pop = "filters" | "sorts" | "fields" | "io" | null;

export function Toolbar({ onToggleAi }: { onToggleAi: () => void }) {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const [pop, setPop] = useState<Pop>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useOutsideClick(popRef, () => setPop(null));

  if (!table || !view) return null;

  const filters = view.config.filters ?? [];
  const sorts = view.config.sorts ?? [];
  const hidden = view.config.hiddenFields ?? [];
  const filterableFields = table.fields.filter((f) => f.type !== "formula");

  const setFilters = (fs: FilterSpec[]) => void store.patchViewConfig({ filters: fs });
  const setSorts = (ss: SortSpec[]) => void store.patchViewConfig({ sorts: ss });

  return (
    <div className="toolbar">
      <button className="btn primary" onClick={() => store.setOpenRecord("new")}>
        + Novo registro
      </button>

      <div className="toolbar-pops" ref={pop ? popRef : undefined}>
        <button className={"btn" + (filters.length ? " active" : "")} onClick={() => setPop(pop === "filters" ? null : "filters")}>
          ⧩ Filtros{filters.length ? ` (${filters.length})` : ""}
        </button>
        <button className={"btn" + (sorts.length ? " active" : "")} onClick={() => setPop(pop === "sorts" ? null : "sorts")}>
          ⇅ Ordenar{sorts.length ? ` (${sorts.length})` : ""}
        </button>
        <button className={"btn" + (hidden.length ? " active" : "")} onClick={() => setPop(pop === "fields" ? null : "fields")}>
          👁 Campos{hidden.length ? ` (${hidden.length} ocultos)` : ""}
        </button>
        <button className="btn" onClick={() => setPop(pop === "io" ? null : "io")}>
          ⇄ Importar/Exportar
        </button>

        {pop === "filters" && (
          <div className="pop">
            {filters.map((f, i) => {
              const meta = table.fields.find((x) => x.id === f.fieldId);
              const ops = meta ? opsForType(meta.type) : [];
              const cur = ops.find((o) => o.op === f.op);
              return (
                <div key={i} className="pop-row">
                  <select
                    className="input input-sm"
                    value={f.fieldId}
                    onChange={(e) => {
                      const nf = table.fields.find((x) => x.id === e.target.value)!;
                      const first = opsForType(nf.type)[0];
                      setFilters(filters.map((x, j) => (j === i ? { fieldId: nf.id, op: first.op, value: "" } : x)));
                    }}
                  >
                    {filterableFields.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input input-sm"
                    value={f.op}
                    onChange={(e) =>
                      setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterSpec["op"] } : x)))
                    }
                  >
                    {ops.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {cur?.needsValue &&
                    (meta?.type === "select" || meta?.type === "multi_select" ? (
                      <select
                        className="input input-sm"
                        value={String(f.value ?? "")}
                        onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      >
                        <option value="">—</option>
                        {(meta.options.choices ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input input-sm"
                        type={meta?.type === "date" ? "date" : "text"}
                        value={String(f.value ?? "")}
                        onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      />
                    ))}
                  <button className="icon-btn" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              );
            })}
            <button
              className="btn btn-sm"
              onClick={() => {
                const f = filterableFields[0];
                if (!f) return;
                setFilters([...filters, { fieldId: f.id, op: opsForType(f.type)[0].op, value: "" }]);
              }}
            >
              + Adicionar filtro
            </button>
          </div>
        )}

        {pop === "sorts" && (
          <div className="pop">
            {sorts.map((s, i) => (
              <div key={i} className="pop-row">
                <select
                  className="input input-sm"
                  value={s.fieldId}
                  onChange={(e) => setSorts(sorts.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}
                >
                  {filterableFields.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <select
                  className="input input-sm"
                  value={s.desc ? "desc" : "asc"}
                  onChange={(e) => setSorts(sorts.map((x, j) => (j === i ? { ...x, desc: e.target.value === "desc" } : x)))}
                >
                  <option value="asc">crescente</option>
                  <option value="desc">decrescente</option>
                </select>
                <button className="icon-btn" onClick={() => setSorts(sorts.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-sm"
              onClick={() => filterableFields[0] && setSorts([...sorts, { fieldId: filterableFields[0].id, desc: false }])}
            >
              + Adicionar ordenação
            </button>
          </div>
        )}

        {pop === "fields" && (
          <div className="pop">
            {table.fields.map((f, i) => (
              <label key={f.id} className="pop-row check-label">
                <input
                  type="checkbox"
                  disabled={i === 0}
                  checked={!hidden.includes(f.id)}
                  onChange={(e) =>
                    void store.patchViewConfig({
                      hiddenFields: e.target.checked ? hidden.filter((h) => h !== f.id) : [...hidden, f.id],
                    })
                  }
                />
                <span className="ftype">{FIELD_TYPE_ICON[f.type]}</span> {f.name}
              </label>
            ))}
          </div>
        )}

        {pop === "io" && (
          <div className="pop">
            <button
              className="menu-item"
              onClick={() => {
                setPop(null);
                void importFile(store);
              }}
            >
              📥 Importar CSV/XLSX (nova tabela)
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setPop(null);
                void exportTable(table, store.rows, "xlsx");
              }}
            >
              📤 Exportar XLSX
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setPop(null);
                void exportTable(table, store.rows, "csv");
              }}
            >
              📤 Exportar CSV
            </button>
          </div>
        )}
      </div>

      <button
        className="btn"
        title="Desfazer (Ctrl+Z)"
        disabled={!store.undoStack.length}
        onClick={() => void store.undo()}
      >
        ↶
      </button>
      <button
        className="btn"
        title="Refazer (Ctrl+Y)"
        disabled={!store.redoStack.length}
        onClick={() => void store.redo()}
      >
        ↷
      </button>

      <span style={{ flex: 1 }} />
      {store.loading && <span className="muted rec-count">carregando…</span>}
      <span className="muted rec-count">
        {store.total} registro{store.total === 1 ? "" : "s"}
      </span>
      <input
        className="input search"
        placeholder="Buscar…"
        value={store.search}
        onChange={(e) => store.setSearch(e.target.value)}
      />
      <button className="btn ai-btn" onClick={onToggleAi}>
        ✦ IA
      </button>
    </div>
  );
}
