// Barra superior: nome da base, abas de tabela, tema e fechar base.

import { useRef, useState } from "react";
import { activeTable, useStore } from "../state/store";
import { useOutsideClick } from "./cells";

export function TopBar({ theme, onToggleTheme }: { theme: string; onToggleTheme: () => void }) {
  const store = useStore();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(menuRef, () => setMenuFor(null));

  const schema = store.schema;
  if (!schema) return null;
  const table = activeTable(store);

  return (
    <header className="topbar">
      <div className="brand" title={schema.path}>
        <span className="brand-logo">◩</span>
        <span className="brand-name">{schema.name}</span>
      </div>
      <nav className="table-tabs">
        {schema.tables.map((t) => (
          <div key={t.id} className={"table-tab" + (t.id === store.activeTableId ? " active" : "")}>
            <button
              className="table-tab-btn"
              onClick={() => store.setActiveTable(t.id)}
              onDoubleClick={() => {
                const name = prompt("Novo nome da tabela:", t.name);
                if (name?.trim()) void store.renameTable(t.id, name.trim());
              }}
            >
              {t.name}
            </button>
            {t.id === store.activeTableId && (
              <>
                <button className="icon-btn tab-more" onClick={() => setMenuFor(menuFor === t.id ? null : t.id)}>
                  ▾
                </button>
                {menuFor === t.id && (
                  <div ref={menuRef} className="menu">
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuFor(null);
                        const name = prompt("Novo nome da tabela:", t.name);
                        if (name?.trim()) void store.renameTable(t.id, name.trim());
                      }}
                    >
                      ✏️ Renomear tabela
                    </button>
                    {schema.tables.length > 1 && (
                      <button
                        className="menu-item danger"
                        onClick={() => {
                          setMenuFor(null);
                          if (confirm(`Excluir a tabela "${t.name}" e TODOS os registros?`)) {
                            void store.deleteTable(t.id);
                          }
                        }}
                      >
                        🗑 Excluir tabela
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <button
          className="table-tab-add"
          title="Nova tabela"
          onClick={() => {
            const name = prompt("Nome da nova tabela:", `Tabela ${schema.tables.length + 1}`);
            if (name?.trim()) void store.addTable(name.trim());
          }}
        >
          +
        </button>
      </nav>
      <span style={{ flex: 1 }} />
      {table && <span className="muted topbar-hint">{table.fields.length} campos</span>}
      <button className="icon-btn" title="Alternar tema" onClick={onToggleTheme}>
        {theme === "dark" ? "☀" : "🌙"}
      </button>
      <button className="btn" onClick={() => void store.closeBase()}>
        Fechar base
      </button>
    </header>
  );
}
