// Barra superior: nome da base, abas de tabela, extensões, servidor, histórico,
// tema e fechar base.

import { useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { activeTable, useStore } from "../state/store";
import { extensionsDir, useExtensions } from "../lib/extensions";
import { inTauri } from "../lib/backend";
import { isRemote, useRemote } from "../lib/remote";
import { useOutsideClick } from "./cells";
import { ServerPanel } from "./ServerPanel";
import { AuditPanel } from "./AuditPanel";
import { LocalePicker } from "./LocalePicker";
import { t as tr } from "../lib/i18n";

export function TopBar({ theme, onToggleTheme }: { theme: string; onToggleTheme: () => void }) {
  const store = useStore();
  const ext = useExtensions();
  const remote = useRemote();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [extMenu, setExtMenu] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const extRef = useRef<HTMLDivElement>(null);
  useOutsideClick(menuRef, () => setMenuFor(null));
  useOutsideClick(extRef, () => setExtMenu(false));
  const remoteAdmin = !isRemote() || remote.session?.role === "admin";

  const openExtensionsFolder = async () => {
    try {
      const dir = await extensionsDir();
      await openPath(dir);
    } catch (e) {
      store.setError(e instanceof Error ? e.message : String(e));
    }
  };

  const schema = store.schema;
  if (!schema) return null;
  const table = activeTable(store);

  const dropTab = (targetId: string) => {
    if (!dragTab || dragTab === targetId) {
      setDragTab(null);
      return;
    }
    const ids = schema.tables.map((t) => t.id);
    const from = ids.indexOf(dragTab);
    const to = ids.indexOf(targetId);
    if (from >= 0 && to >= 0) {
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      void store.reorderTables(ids);
    }
    setDragTab(null);
  };

  return (
    <header className="topbar">
      <div className="brand" title={schema.path}>
        <span className="brand-logo">◩</span>
        <span className="brand-name">{schema.name}</span>
      </div>
      <nav className="table-tabs">
        {schema.tables.map((t) => (
          <div
            key={t.id}
            className={"table-tab" + (t.id === store.activeTableId ? " active" : "") + (dragTab === t.id ? " dragging" : "")}
            onDragOver={(e) => dragTab && e.preventDefault()}
            onDrop={() => dropTab(t.id)}
          >
            <button
              className="table-tab-btn"
              draggable
              onDragStart={(e) => {
                setDragTab(t.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragTab(null)}
              onClick={() => store.setActiveTable(t.id)}
              onDoubleClick={() => {
                const name = prompt(tr("tb.renameTablePrompt"), t.name);
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
                        const name = prompt(tr("tb.renameTablePrompt"), t.name);
                        if (name?.trim()) void store.renameTable(t.id, name.trim());
                      }}
                    >
                      {tr("tb.renameTable")}
                    </button>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuFor(null);
                        void store.duplicateTable(t.id);
                      }}
                    >
                      {tr("tb.dupTable")}
                    </button>
                    {schema.tables.length > 1 && (
                      <button
                        className="menu-item danger"
                        onClick={() => {
                          setMenuFor(null);
                          if (confirm(tr("tb.deleteTableConfirm", { name: t.name }))) {
                            void store.deleteTable(t.id);
                          }
                        }}
                      >
                        {tr("tb.deleteTable")}
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
          title={tr("tb.newTableTitle")}
          onClick={() => {
            const name = prompt(tr("tb.newTablePrompt"), tr("tb.newTableDefault", { n: schema.tables.length + 1 }));
            if (name?.trim()) void store.addTable(name.trim());
          }}
        >
          +
        </button>
      </nav>
      <span style={{ flex: 1 }} />
      {table && <span className="muted topbar-hint">{tr("tb.fieldsCount", { n: table.fields.length })}</span>}
      {inTauri() && (
        <div className="ext-menu-wrap" ref={extRef}>
          <button
            className={"icon-btn" + (ext.errors.length ? " ext-err" : "")}
            title={tr("tb.extTitle")}
            onClick={() => setExtMenu(!extMenu)}
          >
            🧩
          </button>
          {extMenu && (
            <div className="menu ext-menu">
              <div className="ext-menu-head">{tr("tb.extHead")}</div>
              {ext.types.length === 0 && <div className="menu-note muted">{tr("tb.extNone")}</div>}
              {ext.types.map((t) => (
                <div key={t.id} className="menu-note" title={t.description}>
                  {t.icon ?? "🧩"} <strong>{t.name}</strong> <span className="muted">· {t.file}</span>
                </div>
              ))}
              {ext.errors.map((e, i) => (
                <div key={i} className="menu-note ext-error" title={e.message}>
                  ⚠ {e.file}: {e.message}
                </div>
              ))}
              <button
                className="menu-item"
                onClick={() => {
                  setExtMenu(false);
                  void openExtensionsFolder();
                }}
              >
                {tr("tb.extOpenFolder")}
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void ext.reload();
                }}
              >
                {tr("tb.extReload")}
              </button>
              <div className="menu-note muted">{tr("tb.extNote")}</div>
            </div>
          )}
        </div>
      )}
      {isRemote() && (
        <span className="remote-badge" title={tr("tb.remoteBadgeTitle", { url: remote.session?.url ?? "", name: remote.session?.name ?? "" })}>
          🌐 {remote.session?.name} ({remote.session?.role})
        </span>
      )}
      {inTauri() && remoteAdmin && (
        <button className="icon-btn" title={tr("tb.auditTitle")} onClick={() => setAuditOpen(true)}>
          🕘
        </button>
      )}
      {inTauri() && !isRemote() && (
        <button className="icon-btn" title={tr("tb.serverTitle")} onClick={() => setServerOpen(true)}>
          🌐
        </button>
      )}
      <LocalePicker />
      <button className="icon-btn" title={tr("theme.toggle")} onClick={onToggleTheme}>
        {theme === "dark" ? "☀" : "🌙"}
      </button>
      <button className="btn" onClick={() => void store.closeBase()}>
        {isRemote() ? tr("tb.disconnect") : tr("tb.closeBase")}
      </button>
      {serverOpen && <ServerPanel onClose={() => setServerOpen(false)} />}
      {auditOpen && <AuditPanel onClose={() => setAuditOpen(false)} />}
    </header>
  );
}
