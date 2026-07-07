// Sidebar de views da tabela ativa: trocar, criar, renomear e excluir.

import { useRef, useState } from "react";
import { activeTable, useStore } from "../state/store";
import type { ViewKind } from "../lib/types";
import { useOutsideClick } from "./cells";

const KIND_ICON: Record<ViewKind, string> = {
  grid: "▦",
  kanban: "▤",
  calendar: "📅",
  gallery: "🖼",
  form: "📝",
};

const KIND_LABEL: Record<ViewKind, string> = {
  grid: "Grade",
  kanban: "Kanban",
  calendar: "Calendário",
  gallery: "Galeria",
  form: "Formulário",
};

export function ViewSidebar() {
  const store = useStore();
  const table = activeTable(store);
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(addRef, () => setAdding(false));
  useOutsideClick(menuRef, () => setMenuFor(null));

  if (!table) return null;

  return (
    <aside className="view-sidebar">
      <div className="view-sidebar-head">Views</div>
      {table.views.map((v) => (
        <div key={v.id} className={"view-item" + (v.id === store.activeViewId ? " active" : "")}>
          <button className="view-item-btn" onClick={() => store.setActiveView(v.id)}>
            <span className="view-icon">{KIND_ICON[v.kind]}</span>
            <span className="view-name">{v.name}</span>
          </button>
          <button className="icon-btn view-more" onClick={() => setMenuFor(menuFor === v.id ? null : v.id)}>
            ⋯
          </button>
          {menuFor === v.id && (
            <div ref={menuRef} className="menu">
              <button
                className="menu-item"
                onClick={() => {
                  setMenuFor(null);
                  const name = prompt("Novo nome da view:", v.name);
                  if (name?.trim()) void store.renameView(v.id, name.trim());
                }}
              >
                ✏️ Renomear
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setMenuFor(null);
                  void store.duplicateView(v.id);
                }}
              >
                ⧉ Duplicar
              </button>
              {table.views.length > 1 && (
                <button
                  className="menu-item danger"
                  onClick={() => {
                    setMenuFor(null);
                    if (confirm(`Excluir a view "${v.name}"?`)) void store.deleteView(v.id);
                  }}
                >
                  🗑 Excluir
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="view-add" ref={addRef}>
        <button className="btn btn-sm" onClick={() => setAdding(!adding)}>
          + Nova view
        </button>
        {adding && (
          <div className="menu">
            {(Object.keys(KIND_LABEL) as ViewKind[]).map((k) => (
              <button
                key={k}
                className="menu-item"
                onClick={() => {
                  setAdding(false);
                  void store.addView(KIND_LABEL[k], k, {});
                }}
              >
                {KIND_ICON[k]} {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
